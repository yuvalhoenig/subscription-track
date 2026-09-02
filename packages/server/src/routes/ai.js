/**
 * AI endpoints: chat assistant, natural-language extraction, receipt OCR,
 * e-mail scanning and voice transcription.
 *
 * Every route here is behind `aiLimiter`, which enforces the per-user
 * hourly ceiling on Claude calls. That is a budget control rather than an
 * abuse control — these are the only endpoints that cost real money per
 * request.
 */

import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { asyncHandler, badRequest, serviceUnavailable } from '../lib/errors.js';
import { validate, uuid, shortText } from '../lib/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { aiLimiter, uploadLimiter } from '../middleware/rateLimit.js';
import { config, aiEnabled } from '../config/index.js';
import { chat, chatHistory, chatSessions, confirmAction } from '../services/ai/assistant.js';
import { extractSubscription } from '../services/ai/nlp.js';
import { parseReceiptText, parseReceiptImage } from '../services/ai/receipts.js';
import { scanEmails, parseEmail } from '../services/ai/emailParser.js';
import { categorise, userCategoryNames } from '../services/ai/categorize.js';
import { narrativeReport } from '../services/ai/insights.js';

export const aiRouter = Router();
aiRouter.use(requireAuth);

/**
 * Uploads are held in memory, never written to disk: a receipt image is
 * used once and discarded, so there is nothing to clean up and no path
 * traversal surface.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.ocr.maxUploadBytes, files: 1 },
  fileFilter: (_req, file, callback) => {
    if (/^image\/(png|jpe?g|webp|gif|bmp|tiff)$/i.test(file.mimetype)) return callback(null, true);
    return callback(badRequest('Upload a PNG, JPEG, WebP, GIF, BMP or TIFF image'));
  },
});

/** Tells the client which AI features are live. */
aiRouter.get('/status', (_req, res) => {
  res.json({
    enabled: aiEnabled(),
    // Everything still works without a key; it just uses heuristics.
    mode: aiEnabled() ? 'claude' : 'heuristic',
    models: aiEnabled() ? { fast: config.ai.fastModel, smart: config.ai.smartModel } : null,
    features: {
      chat: true,
      extraction: true,
      categorisation: true,
      insights: true,
      receiptOcr: config.ocr.provider !== 'off',
      emailScan: true,
      voice: config.voice.provider,
    },
    rateLimitPerHour: config.ai.rateLimitPerHour,
  });
});

aiRouter.post(
  '/chat',
  aiLimiter,
  validate(
    z
      .object({
        message: z.string().trim().min(1, 'Say something').max(4000),
        sessionId: uuid.optional(),
      })
      .strict(),
  ),
  asyncHandler(async (req, res) => {
    const result = await chat(req.user.id, req.body);
    res.json({ ...result, aiBudget: req.aiBudget ?? null });
  }),
);

aiRouter.get(
  '/chat/sessions',
  asyncHandler(async (req, res) => {
    res.json({ sessions: await chatSessions(req.user.id) });
  }),
);

aiRouter.get(
  '/chat/:sessionId',
  asyncHandler(async (req, res) => {
    res.json({ messages: await chatHistory(req.user.id, req.params.sessionId) });
  }),
);

/**
 * Execute an action the assistant proposed.
 * Separate from /chat so a destructive change always requires a fresh,
 * explicit request from the authenticated user.
 */
aiRouter.post(
  '/chat/confirm',
  validate(
    z
      .object({
        action: z
          .object({
            type: z.literal('cancel_subscription'),
            subscriptionId: uuid,
          })
          .strict(),
      })
      .strict(),
  ),
  asyncHandler(async (req, res) => {
    res.json(await confirmAction(req.user.id, req.body.action));
  }),
);

aiRouter.post(
  '/extract',
  aiLimiter,
  validate(z.object({ text: z.string().trim().min(1).max(2000) }).strict()),
  asyncHandler(async (req, res) => {
    res.json(await extractSubscription(req.body.text));
  }),
);

aiRouter.post(
  '/categorise',
  aiLimiter,
  validate(
    z
      .object({
        name: z.string().trim().min(1).max(120),
        description: shortText(500).optional(),
      })
      .strict(),
  ),
  asyncHandler(async (req, res) => {
    res.json(
      await categorise({
        ...req.body,
        userCategories: await userCategoryNames(req.user.id),
      }),
    );
  }),
);

aiRouter.post(
  '/receipt/text',
  aiLimiter,
  validate(z.object({ text: z.string().trim().min(1).max(20_000) }).strict()),
  asyncHandler(async (req, res) => {
    res.json(await parseReceiptText(req.body.text));
  }),
);

aiRouter.post(
  '/receipt/image',
  uploadLimiter,
  aiLimiter,
  upload.single('receipt'),
  asyncHandler(async (req, res) => {
    if (!req.file?.buffer) throw badRequest('Attach an image as the "receipt" field');
    if (config.ocr.provider === 'off') throw serviceUnavailable('Receipt OCR is disabled');
    res.json(await parseReceiptImage(req.file.buffer));
  }),
);

const emailSchema = z
  .object({
    id: shortText(200).optional(),
    from: shortText(300).optional(),
    subject: shortText(500).optional(),
    body: z.string().max(100_000).optional(),
    receivedAt: z.coerce.date().optional(),
  })
  .strip();

aiRouter.post(
  '/email/parse',
  aiLimiter,
  validate(emailSchema),
  asyncHandler(async (req, res) => {
    res.json(await parseEmail(req.body));
  }),
);

/**
 * Batch scan. The client (web upload or the desktop app reading Mail.app)
 * pushes messages in; nothing is imported automatically — the response
 * lists candidates with duplicate flags for the user to choose from.
 */
aiRouter.post(
  '/email/scan',
  aiLimiter,
  validate(z.object({ messages: z.array(emailSchema).min(1).max(100) }).strict()),
  asyncHandler(async (req, res) => {
    res.json(await scanEmails(req.user.id, req.body.messages));
  }),
);

aiRouter.get(
  '/report',
  aiLimiter,
  validate(z.object({ period: z.enum(['week', 'month', 'year']).default('month') }).strip(), 'query'),
  asyncHandler(async (req, res) => {
    res.json(await narrativeReport(req.user.id, { period: req.query.period }));
  }),
);

/**
 * Voice transcription.
 *
 * `native` (the default) means the client transcribes locally — the Web
 * Speech API in the browser, or macOS speech recognition in the desktop
 * app — and posts text to /chat instead. That keeps audio on the user's
 * device and costs nothing, so it is the recommended path. This endpoint
 * exists for clients that cannot do local recognition.
 */
const audioUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, callback) => {
    if (/^audio\//i.test(file.mimetype) || /^video\/(webm|mp4)$/i.test(file.mimetype)) {
      return callback(null, true);
    }
    return callback(badRequest('Upload an audio file'));
  },
});

aiRouter.post(
  '/voice/transcribe',
  uploadLimiter,
  audioUpload.single('audio'),
  asyncHandler(async (req, res) => {
    if (config.voice.provider === 'native') {
      throw badRequest(
        'This server is configured for on-device transcription. Use the client\'s speech recognition and post the text to /api/ai/chat.',
      );
    }
    if (config.voice.provider !== 'openai' || !config.voice.openaiKey) {
      throw serviceUnavailable('Server-side voice transcription is not configured');
    }
    if (!req.file?.buffer) throw badRequest('Attach audio as the "audio" field');

    // Whisper via multipart. Kept inline rather than adding the OpenAI SDK
    // for a single endpoint most deployments never enable.
    const form = new FormData();
    form.append('file', new Blob([req.file.buffer], { type: req.file.mimetype }), req.file.originalname ?? 'audio.webm');
    form.append('model', 'whisper-1');
    if (req.body?.language) form.append('language', String(req.body.language).slice(0, 8));

    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.voice.openaiKey}` },
      body: form,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw serviceUnavailable(`Transcription failed (${response.status}): ${detail.slice(0, 200)}`);
    }
    const data = await response.json();
    res.json({ text: data.text ?? '', provider: 'openai-whisper' });
  }),
);
