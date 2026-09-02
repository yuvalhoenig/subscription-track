/**
 * Mail.app integration (macOS only).
 *
 * Reads recent messages that look like subscription confirmations and hands
 * them to the renderer, which posts them to /api/ai/email/scan for parsing.
 *
 * Implemented with AppleScript via `osascript` rather than an IMAP client,
 * for two reasons: it needs no credentials at all (it asks the running Mail
 * app, which is already authenticated), and macOS gates it behind an
 * explicit user consent prompt for Automation access. Nothing is read until
 * the user grants that.
 *
 * Only headers and a truncated body are extracted, and nothing is stored on
 * disk here — the messages go straight to the parser and are discarded.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from './config.js';

const run = promisify(execFile);

/** Field separator unlikely to appear in a mail body. */
const FIELD = '<<|SUBTRACK|>>';
const RECORD = '<<|ENDMSG|>>';

/**
 * AppleScript to pull recent messages whose subject looks transactional.
 * Filtering in AppleScript rather than in JS keeps the amount of mail
 * content crossing the process boundary small.
 */
const SCRIPT = `
on run argv
  set maxCount to (item 1 of argv) as integer
  set daysBack to (item 2 of argv) as integer
  set cutoff to (current date) - (daysBack * days)
  set out to ""
  set collected to 0

  tell application "Mail"
    repeat with acct in accounts
      try
        set inboxMessages to (messages of mailbox "INBOX" of acct)
      on error
        set inboxMessages to {}
      end try

      repeat with msg in inboxMessages
        if collected >= maxCount then exit repeat
        try
          set msgDate to date received of msg
          if msgDate > cutoff then
            set subj to subject of msg
            set lowerSubj to my toLower(subj)
            -- Cheap pre-filter: only messages that read like a receipt,
            -- confirmation or renewal notice are worth extracting.
            if lowerSubj contains "receipt" or lowerSubj contains "subscription" ¬
              or lowerSubj contains "invoice" or lowerSubj contains "payment" ¬
              or lowerSubj contains "renew" or lowerSubj contains "trial" ¬
              or lowerSubj contains "your plan" or lowerSubj contains "membership" then
              set snd to sender of msg
              try
                set bod to (content of msg)
              on error
                set bod to ""
              end try
              if (count of bod) > 4000 then set bod to (text 1 thru 4000 of bod)
              set out to out & (id of msg as string) & "${FIELD}" & snd & "${FIELD}" & subj ¬
                & "${FIELD}" & ((msgDate as string)) & "${FIELD}" & bod & "${RECORD}"
              set collected to collected + 1
            end if
          end if
        end try
      end repeat
    end repeat
  end tell
  return out
end run

on toLower(theText)
  set lowerChars to "abcdefghijklmnopqrstuvwxyz"
  set upperChars to "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
  set result to ""
  repeat with c in the characters of theText
    set i to offset of c in upperChars
    if i > 0 then
      set result to result & (character i of lowerChars)
    else
      set result to result & c
    end if
  end repeat
  return result
end toLower
`;

export function mailAvailable() {
  return config.isMac;
}

/**
 * Read candidate subscription e-mails from Mail.app.
 *
 * @param {object} [options]
 * @param {number} [options.limit]    Maximum messages to return.
 * @param {number} [options.daysBack] How far back to look.
 * @returns {Promise<{messages: Array, error?: string}>}
 */
export async function readSubscriptionMail({ limit = 40, daysBack = 120 } = {}) {
  if (!config.isMac) {
    return { messages: [], error: 'Mail.app integration is only available on macOS.' };
  }

  try {
    const { stdout } = await run(
      'osascript',
      ['-e', SCRIPT, String(limit), String(daysBack)],
      // Mail can be slow to answer on a large mailbox; a generous timeout
      // beats failing on a legitimately busy inbox.
      { timeout: 90_000, maxBuffer: 12 * 1024 * 1024 },
    );

    const messages = stdout
      .split(RECORD)
      .map((record) => record.trim())
      .filter(Boolean)
      .map((record) => {
        const [id, from, subject, receivedAt, body] = record.split(FIELD);
        return {
          id,
          from: (from ?? '').trim(),
          subject: (subject ?? '').trim(),
          // AppleScript's date string is locale-formatted; Date.parse
          // handles the common US form and we fall back to undefined.
          receivedAt: Number.isNaN(Date.parse(receivedAt)) ? undefined : new Date(receivedAt).toISOString(),
          body: body ?? '',
        };
      });

    return { messages };
  } catch (error) {
    // The most common failure by far is the user not having granted
    // Automation access, which surfaces as error -1743.
    if (/-1743|not authori[sz]ed|Not allowed/i.test(error.message)) {
      return {
        messages: [],
        error:
          'SubTrack needs permission to read Mail. Grant it in System Settings → '
          + 'Privacy & Security → Automation → SubTrack → Mail, then try again.',
      };
    }
    if (/-600|not running/i.test(error.message)) {
      return { messages: [], error: 'Mail is not running. Open Mail and try again.' };
    }
    if (error.killed || /timed out|ETIMEDOUT/i.test(error.message)) {
      return { messages: [], error: 'Mail took too long to respond. Try a shorter date range.' };
    }
    return { messages: [], error: `Could not read Mail: ${error.message}` };
  }
}

export default { mailAvailable, readSubscriptionMail };
