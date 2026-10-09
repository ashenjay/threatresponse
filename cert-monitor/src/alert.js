'use strict';

/*
 * Optional email alerting via SMTP.
 *
 * nodemailer is an OPTIONAL dependency. If it is not installed, or alerting is
 * disabled, this module degrades to logging — the monitor keeps working.
 *
 * Config comes from the environment so no secret is ever committed:
 *   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_SECURE ('true'|'false'),
 *   ALERT_FROM, ALERT_TO (comma-separated).
 */

let nodemailer = null;
try {
  // eslint-disable-next-line global-require
  nodemailer = require('nodemailer');
} catch (_) {
  nodemailer = null; // not installed — we'll log instead
}

const lastSent = new Map(); // key -> timestamp(ms)

function buildTransport() {
  if (!nodemailer) return null;
  if (!process.env.SMTP_HOST) return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined,
  });
}

/**
 * @param {Array} problems - [{ key, subject, body }]
 * @param {object} alertCfg - { enabled, throttleHours }
 */
async function sendAlerts(problems, alertCfg) {
  if (!problems.length) return;
  if (!alertCfg || !alertCfg.enabled) return;

  const transport = buildTransport();
  const throttleMs = (alertCfg.throttleHours || 12) * 3600 * 1000;
  const now = Date.now();

  const toSend = problems.filter((p) => {
    const prev = lastSent.get(p.key) || 0;
    return now - prev >= throttleMs;
  });
  if (!toSend.length) return;

  const to = (process.env.ALERT_TO || '').split(',').map((s) => s.trim()).filter(Boolean);
  const from = process.env.ALERT_FROM || 'sms-monitor@ndblk.int';

  const subject = `[SMS Monitor] ${toSend.length} alert(s): ` +
    toSend.map((p) => p.subject).join('; ').slice(0, 120);
  const body = toSend.map((p) => `• ${p.subject}\n  ${p.body}`).join('\n\n');

  if (!transport || !to.length) {
    // No transport configured — log so operators still see it.
    console.warn('[alert] (email not configured, logging instead)\n' + body);
    toSend.forEach((p) => lastSent.set(p.key, now));
    return;
  }

  try {
    await transport.sendMail({ from, to, subject, text: body });
    toSend.forEach((p) => lastSent.set(p.key, now));
    console.log(`[alert] sent ${toSend.length} alert(s) to ${to.join(', ')}`);
  } catch (err) {
    console.error('[alert] send failed:', err.message);
  }
}

module.exports = { sendAlerts };
