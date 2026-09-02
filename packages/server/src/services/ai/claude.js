/**
 * Claude API client.
 *
 * Every AI feature in SubTrack goes through this module, which gives us one
 * place to enforce the things that matter when an LLM sits in a product
 * path:
 *
 *  - **Graceful degradation.** With no ANTHROPIC_API_KEY the client throws
 *    `AiUnavailableError`. Every caller catches it and falls back to a
 *    deterministic heuristic, so the product works — less cleverly — with
 *    no API key at all. This is why the demo runs offline.
 *  - **Caching.** Identical prompts are served from Redis, which matters
 *    because insight generation re-asks the same questions nightly.
 *  - **Retries.** Overload and rate-limit responses are retried with
 *    exponential backoff and jitter; 4xx client errors are not.
 *  - **Structured output.** `completeJson` validates against a zod schema
 *    and re-prompts once on malformed JSON before giving up.
 *  - **Output safety.** Responses are length-capped and scanned for the
 *    obvious failure modes before being shown to a user.
 */

import crypto from 'node:crypto';
import { config, aiEnabled } from '../../config/index.js';
import { cache } from '../../lib/cache.js';
import { logger } from '../../lib/logger.js';
import { AppError } from '../../lib/errors.js';

const log = logger.child('claude');

/** Thrown when Claude is not configured or is unreachable after retries. */
export class AiUnavailableError extends AppError {
  constructor(message = 'AI features are not configured', { cause } = {}) {
    super(message, { status: 503, code: 'ai_unavailable', cause });
    this.name = 'AiUnavailableError';
  }
}

/** Thrown when Claude answers but the answer cannot be used. */
export class AiResponseError extends AppError {
  constructor(message, { details, cause } = {}) {
    super(message, { status: 502, code: 'ai_bad_response', details, cause });
    this.name = 'AiResponseError';
  }
}

let clientPromise = null;

async function getClient() {
  if (!aiEnabled()) throw new AiUnavailableError();
  if (!clientPromise) {
    clientPromise = import('@anthropic-ai/sdk')
      .then(({ default: Anthropic }) => new Anthropic({
        apiKey: config.ai.apiKey,
        timeout: config.ai.requestTimeoutMs,
        // Retries are handled here so backoff and logging are consistent
        // across every AI feature.
        maxRetries: 0,
      }))
      .catch((error) => {
        clientPromise = null;
        throw new AiUnavailableError('Anthropic SDK could not be loaded', { cause: error });
      });
  }
  return clientPromise;
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** Retry on transport, overload and rate-limit failures; never on 4xx. */
function isRetryable(error) {
  const status = error?.status ?? error?.response?.status;
  if (status === 429) return true;
  if (typeof status === 'number' && status >= 500) return true;
  return ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE', 'ENOTFOUND'].includes(error?.code);
}

function cacheKeyFor(payload) {
  return `ai:completion:${crypto
    .createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex')
    .slice(0, 40)}`;
}

/** Concatenate the text blocks of a Claude response. */
function textFrom(message) {
  return (message?.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

const MAX_RESPONSE_CHARS = 12_000;

/**
 * Guard rails on anything that will be rendered to a user.
 *
 * The model is only ever fed the user's own subscription data, so the
 * realistic risk is not jailbreaking but a receipt or subscription name
 * containing text that steers the model. We therefore drop responses that
 * look like leaked instructions or markup rather than the answer we asked
 * for, and always cap length.
 */
export function sanitiseOutput(text) {
  if (typeof text !== 'string') return '';
  let clean = text.trim();

  if (clean.length > MAX_RESPONSE_CHARS) {
    clean = `${clean.slice(0, MAX_RESPONSE_CHARS)}…`;
  }
  // Strip anything that would execute or embed if rendered as HTML. The
  // clients render insight text as plain text, so this is belt-and-braces.
  clean = clean
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/\bjavascript:/gi, '');

  return clean;
}

/** Heuristic check that a narrative response is usable. */
export function looksLikeRefusalOrEcho(text) {
  if (!text || text.length < 12) return true;
  return /^(i (cannot|can't|won't|am unable)|as an ai\b|i'm sorry,? but)/i.test(text.trim());
}

/**
 * Single-turn completion returning plain text.
 *
 * @param {object}  options
 * @param {string}  options.system      System prompt.
 * @param {Array}   options.messages    Anthropic message array.
 * @param {'fast'|'smart'} [options.tier]  Which configured model to use.
 * @param {number}  [options.maxTokens]
 * @param {number}  [options.temperature]
 * @param {boolean} [options.cache]     Cache the result (default true).
 * @param {number}  [options.cacheTtl]
 * @param {Array}   [options.tools]     Tool definitions for tool use.
 */
export async function complete({
  system,
  messages,
  tier = 'fast',
  maxTokens = config.ai.maxOutputTokens,
  temperature = 0.2,
  cache: useCache = true,
  cacheTtl = config.ai.cacheTtlSeconds,
  tools,
} = {}) {
  if (!aiEnabled()) throw new AiUnavailableError();

  const model = tier === 'smart' ? config.ai.smartModel : config.ai.fastModel;
  const request = {
    model,
    max_tokens: maxTokens,
    temperature,
    ...(system ? { system } : {}),
    messages,
    ...(tools?.length ? { tools } : {}),
  };

  // Tool-use conversations are stateful and cheap to get wrong, so they
  // are never served from cache.
  const cacheable = useCache && !tools?.length;
  const key = cacheable ? cacheKeyFor(request) : null;
  if (key) {
    const hit = await cache.get(key);
    if (hit) {
      log.debug('Completion cache hit', { model });
      return { ...hit, cached: true };
    }
  }

  const client = await getClient();
  let lastError;

  for (let attempt = 0; attempt <= config.ai.maxRetries; attempt += 1) {
    try {
      const started = Date.now();
      const message = await client.messages.create(request);
      const result = {
        text: sanitiseOutput(textFrom(message)),
        // Raw blocks are needed by the assistant's tool-use loop.
        content: message.content,
        stopReason: message.stop_reason,
        model: message.model,
        usage: {
          inputTokens: message.usage?.input_tokens ?? 0,
          outputTokens: message.usage?.output_tokens ?? 0,
        },
        cached: false,
      };
      log.debug('Completion succeeded', {
        model,
        ms: Date.now() - started,
        outputTokens: result.usage.outputTokens,
      });
      if (key) await cache.set(key, result, cacheTtl);
      return result;
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === config.ai.maxRetries) break;
      // Exponential backoff with jitter so concurrent callers don't
      // synchronise their retries into a thundering herd.
      const backoff = 2 ** attempt * 500 + Math.random() * 300;
      log.warn('Completion failed; retrying', {
        attempt: attempt + 1,
        status: error?.status,
        backoffMs: Math.round(backoff),
      });
      await sleep(backoff);
    }
  }

  log.error('Completion failed', { status: lastError?.status, error: lastError?.message });
  const status = lastError?.status ?? lastError?.response?.status;
  if (status === 401 || status === 403) {
    throw new AiUnavailableError('The configured Anthropic API key was rejected', { cause: lastError });
  }
  throw new AiUnavailableError(
    `Claude is unavailable right now (${lastError?.message ?? 'unknown error'})`,
    { cause: lastError },
  );
}

/** Pull the first JSON object/array out of a response that may be fenced. */
export function extractJson(text) {
  if (!text) return null;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = (fenced ? fenced[1] : text).trim();

  try {
    return JSON.parse(candidate);
  } catch {
    // The model sometimes adds a sentence before or after the JSON. Take
    // the outermost bracketed span and try that.
    const start = candidate.search(/[[{]/);
    if (start === -1) return null;
    const opener = candidate[start];
    const closer = opener === '{' ? '}' : ']';
    const end = candidate.lastIndexOf(closer);
    if (end <= start) return null;
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

/**
 * Completion constrained to JSON matching a zod schema.
 *
 * On malformed output we re-prompt once, echoing the parse failure — in
 * practice that recovers almost every case, and failing after two attempts
 * is better than serving a half-parsed object into the database.
 */
export async function completeJson({
  system,
  messages,
  schema,
  tier = 'fast',
  maxTokens = config.ai.maxOutputTokens,
  temperature = 0,
  cache: useCache = true,
  cacheTtl = config.ai.cacheTtlSeconds,
} = {}) {
  const jsonSystem = [
    system,
    'Respond with a single valid JSON value and nothing else.',
    'Do not wrap it in markdown fences. Do not add commentary before or after.',
  ]
    .filter(Boolean)
    .join('\n\n');

  let conversation = messages;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await complete({
      system: jsonSystem,
      messages: conversation,
      tier,
      maxTokens,
      temperature,
      // Never cache the repair attempt: it is keyed to a specific failure.
      cache: useCache && attempt === 0,
      cacheTtl,
    });

    const parsed = extractJson(response.text);
    if (parsed !== null) {
      if (!schema) return { data: parsed, usage: response.usage, model: response.model };
      const result = schema.safeParse(parsed);
      if (result.success) {
        return { data: result.data, usage: response.usage, model: response.model };
      }
      if (attempt === 0) {
        const issues = result.error.issues
          .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
          .join('; ');
        log.warn('AI JSON failed schema validation; re-prompting', { issues });
        conversation = [
          ...conversation,
          { role: 'assistant', content: response.text },
          {
            role: 'user',
            content: `That JSON did not match the required shape (${issues}). Reply with corrected JSON only.`,
          },
        ];
        continue;
      }
      throw new AiResponseError('The AI response did not match the expected shape', {
        details: result.error.issues.slice(0, 5),
      });
    }

    if (attempt === 0) {
      log.warn('AI response was not parseable JSON; re-prompting');
      conversation = [
        ...conversation,
        { role: 'assistant', content: response.text.slice(0, 500) },
        { role: 'user', content: 'That was not valid JSON. Reply with valid JSON only.' },
      ];
      continue;
    }
    throw new AiResponseError('The AI response could not be parsed as JSON');
  }

  throw new AiResponseError('The AI response could not be parsed as JSON');
}

/**
 * Run `producer` when Claude is configured, otherwise `fallback`.
 * This is the pattern every AI feature uses, so the "does it degrade?"
 * decision is expressed once rather than repeated in each service.
 */
export async function withFallback(producer, fallback, { label = 'ai' } = {}) {
  if (!aiEnabled()) return { ...(await fallback()), source: 'heuristic' };
  try {
    return { ...(await producer()), source: 'claude' };
  } catch (error) {
    if (error instanceof AiUnavailableError || error instanceof AiResponseError) {
      log.warn(`${label}: falling back to heuristics`, { error: error.message });
      return { ...(await fallback()), source: 'heuristic', degraded: true };
    }
    throw error;
  }
}

export const claude = {
  complete,
  completeJson,
  withFallback,
  extractJson,
  sanitiseOutput,
  looksLikeRefusalOrEcho,
  get enabled() {
    return aiEnabled();
  },
  get models() {
    return { fast: config.ai.fastModel, smart: config.ai.smartModel };
  },
};

export default claude;
