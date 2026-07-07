/**
 * Email helper (Resend via raw fetch — no SDK, on purpose).
 *
 * Shared by the daily digest cron and per-call summary emails.
 *
 * Environment variables:
 * - RESEND_API_KEY: Resend API key
 * - EMAIL_FROM: verified From address
 */

/**
 * Send an email through Resend.
 * @param {Object} message
 * @param {string|string[]} message.to - Recipient(s)
 * @param {string} message.subject
 * @param {string} message.html
 * @param {string} message.text
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function sendEmail({ to, subject, html, text }) {
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  const EMAIL_FROM = process.env.EMAIL_FROM;

  if (!RESEND_API_KEY || !EMAIL_FROM) {
    console.error('❌ Email not configured (RESEND_API_KEY / EMAIL_FROM)');
    return { ok: false, error: 'Email provider not configured' };
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: EMAIL_FROM,
      to,
      subject,
      html,
      text
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('❌ Resend error:', response.status, errorText);
    return { ok: false, error: errorText };
  }

  return { ok: true };
}

/**
 * Escape user-supplied text for safe inclusion in HTML email bodies.
 * @param {string} text
 * @returns {string}
 */
function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

module.exports = {
  sendEmail,
  escapeHtml
};
