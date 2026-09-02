/**
 * Transactional e-mail.
 *
 * With no SMTP_HOST configured — the default for local development — mails
 * are written to the log instead of sent, including the verification and
 * reset links. That keeps the whole signup flow testable with zero setup
 * and means a misconfigured production box logs the mail rather than
 * silently dropping it.
 */

import nodemailer from 'nodemailer';
import { config } from '../config/index.js';
import { logger } from '../lib/logger.js';

const log = logger.child('mail');

let transport = null;

function getTransport() {
  if (transport) return transport;
  if (!config.mail.host) {
    // jsonTransport renders the message without opening a connection.
    transport = nodemailer.createTransport({ jsonTransport: true });
    log.info('SMTP not configured; e-mail will be logged instead of sent');
    return transport;
  }
  transport = nodemailer.createTransport({
    host: config.mail.host,
    port: config.mail.port,
    secure: config.mail.secure,
    auth: config.mail.user ? { user: config.mail.user, pass: config.mail.pass } : undefined,
  });
  return transport;
}

/** Wrap body copy in the shared responsive template. */
function layout({ title, body, cta }) {
  const button = cta
    ? `<p style="margin:32px 0"><a href="${cta.href}" style="background:linear-gradient(135deg,#4f46e5,#7c3aed);color:#fff;padding:14px 28px;border-radius:10px;text-decoration:none;font-weight:600;display:inline-block">${cta.label}</a></p>
       <p style="color:#64748b;font-size:13px;line-height:1.6">If the button does not work, paste this link into your browser:<br><span style="color:#4f46e5;word-break:break-all">${cta.href}</span></p>`
    : '';
  return `<!doctype html>
<html lang="en"><body style="margin:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
  <div style="max-width:560px;margin:0 auto;padding:32px 20px">
    <div style="background:#fff;border-radius:16px;padding:36px;box-shadow:0 4px 24px rgba(15,23,42,.08)">
      <div style="font-size:20px;font-weight:700;color:#0f172a;margin-bottom:4px">SubTrack</div>
      <div style="height:3px;width:48px;background:linear-gradient(90deg,#4f46e5,#7c3aed);border-radius:2px;margin-bottom:24px"></div>
      <h1 style="font-size:22px;color:#0f172a;margin:0 0 16px">${title}</h1>
      <div style="color:#334155;font-size:15px;line-height:1.7">${body}</div>
      ${button}
    </div>
    <p style="color:#94a3b8;font-size:12px;text-align:center;margin-top:20px">
      You are receiving this because you have a SubTrack account.
    </p>
  </div>
</body></html>`;
}

/** Strip tags for the text/plain alternative. */
function toPlainText(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h1|h2|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function send({ to, subject, html }) {
  const text = toPlainText(html);
  try {
    const info = await getTransport().sendMail({
      from: config.mail.from,
      to,
      subject,
      html,
      text,
    });
    if (!config.mail.host) {
      // Make the link copy-pasteable from the dev console.
      log.info(`Mail (not sent — no SMTP configured): ${subject}`, { to, preview: text.slice(0, 400) });
    } else {
      log.info('Mail sent', { to, subject, messageId: info.messageId });
    }
    return { delivered: Boolean(config.mail.host), messageId: info.messageId };
  } catch (error) {
    // A failed reminder must never fail the request that triggered it.
    log.error('Mail delivery failed', { to, subject, error: error.message });
    return { delivered: false, error: error.message };
  }
}

export function verificationEmail({ to, name, token }) {
  const href = `${config.appUrl}/verify-email?token=${encodeURIComponent(token)}`;
  return send({
    to,
    subject: 'Confirm your SubTrack e-mail address',
    html: layout({
      title: `Welcome, ${name.split(' ')[0]}`,
      body: `<p>Confirm this address to switch on renewal reminders and your weekly AI spending digest.</p>
             <p>This link expires in 24 hours.</p>`,
      cta: { href, label: 'Confirm e-mail address' },
    }),
  });
}

export function passwordResetEmail({ to, name, token }) {
  const href = `${config.appUrl}/reset-password?token=${encodeURIComponent(token)}`;
  return send({
    to,
    subject: 'Reset your SubTrack password',
    html: layout({
      title: 'Reset your password',
      body: `<p>Hi ${name.split(' ')[0]}, we received a request to reset your password.
             Choose a new one using the button below — the link expires in one hour.</p>
             <p>If you did not ask for this, you can safely ignore this e-mail;
             your password will not change.</p>`,
      cta: { href, label: 'Choose a new password' },
    }),
  });
}

export function renewalReminderEmail({ to, name, subscription, daysUntil, monthlyTotal }) {
  const when = daysUntil === 0 ? 'today' : daysUntil === 1 ? 'tomorrow' : `in ${daysUntil} days`;
  return send({
    to,
    subject: `${subscription.name} renews ${when} — ${subscription.currency} ${subscription.cost}`,
    html: layout({
      title: `${subscription.name} renews ${when}`,
      body: `<p>Hi ${name.split(' ')[0]},</p>
             <p><strong>${subscription.name}</strong> is set to renew on
             <strong>${subscription.renewal_date}</strong> for
             <strong>${subscription.currency} ${subscription.cost}</strong>
             (${subscription.billing_cycle}).</p>
             <p>Your current tracked spend is <strong>${subscription.currency} ${monthlyTotal}/month</strong>.</p>`,
      cta: { href: `${config.appUrl}/subscriptions/${subscription.id}`, label: 'Review this subscription' },
    }),
  });
}

export function insightDigestEmail({ to, name, insights, monthlyTotal }) {
  const items = insights
    .slice(0, 5)
    .map(
      (insight) =>
        `<li style="margin-bottom:12px"><strong>${insight.title}</strong><br>
         <span style="color:#475569">${insight.content}</span></li>`,
    )
    .join('');
  return send({
    to,
    subject: `Your SubTrack digest — ${insights.length} new insight${insights.length === 1 ? '' : 's'}`,
    html: layout({
      title: 'Your spending digest',
      body: `<p>Hi ${name.split(' ')[0]}, here is what stood out this week.
             You are tracking <strong>${monthlyTotal}/month</strong>.</p>
             <ul style="padding-left:18px">${items}</ul>`,
      cta: { href: `${config.appUrl}/insights`, label: 'Open your dashboard' },
    }),
  });
}

export const mailer = {
  send,
  verificationEmail,
  passwordResetEmail,
  renewalReminderEmail,
  insightDigestEmail,
};

export default mailer;
