/**
 * Daily digest cron endpoint
 * Called by Vercel Cron (UTC schedule) to email business owners a summary.
 */

const { supabaseService } = require('../../lib/supabase');
const { APP_TIME_ZONE } = require('../../lib/time');
const { sendEmail, escapeHtml } = require('../../lib/email');

const CRON_SECRET = process.env.CRON_SECRET;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_FROM = process.env.EMAIL_FROM;
const DASHBOARD_URL = process.env.DASHBOARD_URL;

module.exports = async (req, res) => {
  // Vercel Cron invokes with GET; also allow POST for manual triggers.
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!CRON_SECRET) {
    return res.status(500).json({ error: 'CRON_SECRET not configured' });
  }

  // Vercel Cron sends `Authorization: Bearer ${CRON_SECRET}`. Also accept the
  // legacy `x-cron-secret` header for manual/curl triggers.
  const bearer = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
  const providedSecret = req.headers['x-cron-secret'] || bearer;
  if (providedSecret !== CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!supabaseService) {
    return res.status(500).json({ error: 'Supabase service client not initialized' });
  }

  if (!RESEND_API_KEY || !EMAIL_FROM) {
    return res.status(500).json({ error: 'Email provider not configured' });
  }

  try {
    const window = (req.query?.window || 'previous-day').toString().toLowerCase();
    const { data: businesses, error } = await supabaseService
      .from('businesses')
      .select('id, name, email, timezone, digest_enabled, digest_time_local, digest_timezone, last_digest_sent_at, active')
      .eq('digest_enabled', true)
      .eq('active', true);

    if (error) {
      console.error('❌ Error loading businesses for digest:', error);
      return res.status(500).json({ error: 'Failed to load businesses' });
    }

    let processed = 0;
    let sent = 0;
    const errors = [];

    for (const business of businesses || []) {
      processed += 1;

      try {
        const timeZone = business.digest_timezone || business.timezone || APP_TIME_ZONE;
        if (window === 'previous-day' && !shouldSendDigestNow(business, timeZone)) {
          continue;
        }
        const { startUtc, endUtc, label } = getDigestRangeUtc(window, timeZone);

        const { data: calls, error: callsError } = await supabaseService
          .from('calls')
          .select('id, created_at, from_phone, customer_phone, status, intent, summary')
          .eq('business_id', business.id)
          .gte('created_at', startUtc.toISOString())
          .lt('created_at', endUtc.toISOString())
          .order('created_at', { ascending: false });

        if (callsError) throw callsError;

        const stats = buildCallStats(calls || []);
        const recipient = await resolveRecipientEmail(business);

        if (!recipient) {
          console.warn(`⚠️ No digest recipient for business ${business.id}`);
          continue;
        }

        const email = buildDigestEmail({
          business,
          recipient,
          timeZone,
          label,
          calls: calls || [],
          stats
        });

        const sendResult = await sendEmail(email);
        if (!sendResult.ok) {
          errors.push({ businessId: business.id, error: sendResult.error });
          continue;
        }

        // Only the scheduled previous-day run advances the idempotency stamp.
        // A manual ?window=today/last24 preview must not block the real digest.
        if (window === 'previous-day') {
          await markDigestSent(business.id);
        }
        sent += 1;
      } catch (err) {
        console.error('❌ Digest error for business:', business.id, err);
        errors.push({ businessId: business.id, error: err.message });
      }
    }

    return res.status(200).json({ processed, sent, errors });
  } catch (err) {
    console.error('❌ Digest cron failed:', err);
    return res.status(500).json({ error: 'Digest cron failed', message: err.message });
  }
};

async function resolveRecipientEmail(business) {
  if (business.email) return business.email;

  const { data: owners, error } = await supabaseService
    .from('business_users')
    .select('user_id, role')
    .eq('business_id', business.id)
    .eq('role', 'owner')
    .limit(1);

  if (error || !owners || owners.length === 0) return null;

  const ownerId = owners[0].user_id;
  try {
    const { data } = await supabaseService.auth.admin.getUserById(ownerId);
    return data?.user?.email || null;
  } catch (err) {
    console.error('❌ Failed to load owner email:', err);
    return null;
  }
}

function buildCallStats(calls) {
  const stats = {
    total: calls.length,
    missed: 0,
    intents: {}
  };

  for (const call of calls) {
    if (['no-answer', 'busy', 'failed'].includes(call.status)) {
      stats.missed += 1;
    }
    const intent = call.intent || 'unknown';
    stats.intents[intent] = (stats.intents[intent] || 0) + 1;
  }

  return stats;
}

function buildDigestEmail({ business, recipient, timeZone, label, calls, stats }) {
  const subject = `Daily Call Digest - ${business.name} (${label})`;
  const dashboardLink = DASHBOARD_URL || '';

  const topIntents = Object.entries(stats.intents)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([intent, count]) => `${intent}: ${count}`)
    .join(', ');

  const keyCalls = calls.slice(0, 5).map((call) => ({
    time: formatDateTime(call.created_at, timeZone),
    from: formatDigestPhone(call.from_phone || call.customer_phone),
    status: call.status || 'unknown',
    summary: call.summary ? call.summary.slice(0, 200) : 'No summary'
  }));

  // ---- Plaintext fallback ----
  const text = [
    `Daily Call Digest for ${business.name}`,
    `Date: ${label} (${timeZone})`,
    '',
    `Total calls: ${stats.total}`,
    `Missed calls: ${stats.missed}`,
    `Top intents: ${topIntents || 'None'}`,
    '',
    'Key calls:',
    keyCalls.length
      ? keyCalls.map((c) => `${c.time} | ${c.from} | ${c.status} | ${c.summary}`).join('\n')
      : 'No calls recorded.',
    '',
    dashboardLink ? `Dashboard: ${dashboardLink}` : ''
  ].filter(Boolean).join('\n');

  // ---- Branded HTML (matches the per-call summary email) ----
  const statTile = (labelText, value, valueSize = '26px') => `
              <td width="33.33%" style="padding:6px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F7F1E7;border:1px solid #EBE2D2;border-radius:10px;">
                  <tr><td style="padding:14px 16px;">
                    <div style="font-family:Arial,sans-serif;font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#8A8175;">${labelText}</div>
                    <div style="font-family:Georgia,'Times New Roman',serif;font-size:${valueSize};font-weight:bold;color:#23201B;margin-top:4px;">${value}</div>
                  </td></tr>
                </table>
              </td>`;

  const statusPill = (status) => {
    const missed = ['no-answer', 'busy', 'failed'].includes(status);
    const bg = missed ? '#F6E3DC' : '#EBF0EA';
    const fg = missed ? '#B14A2C' : '#2E5A49';
    return `<span style="display:inline-block;font-family:Arial,sans-serif;font-size:11px;font-weight:600;color:${fg};background:${bg};border-radius:20px;padding:3px 10px;white-space:nowrap;">${escapeHtml(status)}</span>`;
  };

  const callRowsHtml = keyCalls.length
    ? keyCalls.map((c, i) => `
              <tr><td style="padding:${i === 0 ? '0' : '10px'} 0 0;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #EBE2D2;border-radius:10px;">
                  <tr><td style="padding:14px 16px;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
                      <td style="font-family:Arial,sans-serif;font-size:13px;font-weight:600;color:#23201B;vertical-align:middle;">
                        ${escapeHtml(c.from)}
                        <span style="color:#B8AF9E;font-weight:400;">&middot; ${escapeHtml(c.time)}</span>
                      </td>
                      <td align="right" style="vertical-align:middle;">${statusPill(c.status)}</td>
                    </tr></table>
                    <div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.55;color:#5B564E;margin-top:8px;">${escapeHtml(c.summary)}</div>
                  </td></tr>
                </table>
              </td></tr>`).join('')
    : `
              <tr><td style="padding:6px 0;font-family:Arial,sans-serif;font-size:14px;color:#8A8175;text-align:center;">No calls recorded for this period.</td></tr>`;

  const dashboardBtnHtml = dashboardLink
    ? `
            <tr><td style="padding:22px 24px 0;">
              <a href="${dashboardLink}" style="display:inline-block;background:#C2603F;color:#ffffff;text-decoration:none;font-family:Arial,sans-serif;font-size:14px;font-weight:600;padding:11px 22px;border-radius:8px;">Open dashboard &rarr;</a>
            </td></tr>`
    : '';

  const html = `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#FBF7F0;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FBF7F0;padding:28px 12px;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
        <tr><td style="padding:4px 8px 18px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
            <td style="vertical-align:middle;">
              <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#C2603F;vertical-align:middle;"></span>
              <span style="font-family:Georgia,'Times New Roman',serif;font-size:22px;font-weight:bold;color:#23201B;vertical-align:middle;margin-left:8px;">Svaraa</span>
            </td>
            <td align="right" style="font-family:Arial,sans-serif;font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#8A8175;vertical-align:middle;">Daily digest</td>
          </tr></table>
        </td></tr>
        <tr><td style="background:#ffffff;border:1px solid #EBE2D2;border-radius:14px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr><td style="padding:24px 24px 4px;">
              <div style="font-family:Georgia,'Times New Roman',serif;font-size:20px;font-weight:bold;color:#23201B;">${escapeHtml(business.name)}</div>
              <div style="font-family:Arial,sans-serif;font-size:13px;color:#8A8175;margin-top:2px;">Your call summary for ${escapeHtml(label)}.</div>
            </td></tr>
            <tr><td style="padding:16px 18px 4px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
                ${statTile('Total calls', String(stats.total))}
                ${statTile('Missed calls', String(stats.missed))}
                ${statTile('Top intent', escapeHtml(topIntents ? topIntents.split(', ')[0] : 'None'), '15px')}
              </tr></table>
            </td></tr>
            <tr><td style="padding:16px 24px 0;">
              <div style="font-family:Arial,sans-serif;font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#8A8175;margin-bottom:4px;">Key calls</div>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                ${callRowsHtml}
              </table>
            </td></tr>
            ${dashboardBtnHtml}
            <tr><td style="padding:22px 24px;"></td></tr>
          </table>
        </td></tr>
        <tr><td style="padding:16px 8px;font-family:Arial,sans-serif;font-size:12px;color:#A79D8C;">
          Svaraa &middot; AI phone answering for local business &middot; ${escapeHtml(timeZone)}
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  return { to: recipient, subject, html, text };
}

/**
 * Format a phone number for display: +15135921240 → (513) 592-1240.
 * Falls back to the raw value for non-US / unparseable numbers.
 */
function formatDigestPhone(raw) {
  if (!raw) return 'Unknown caller';
  const digits = String(raw).replace(/\D/g, '');
  const ten = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  if (ten.length === 10) return `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`;
  return String(raw);
}

function shouldSendDigestNow(business, timeZone) {
  const digestTime = business.digest_time_local || '08:00';
  const [targetHour, targetMinute] = digestTime.split(':').map((part) => Number(part));

  if (!Number.isFinite(targetHour) || !Number.isFinite(targetMinute)) {
    return false;
  }

  const now = new Date();

  // Idempotency: at most one digest per local day.
  if (business.last_digest_sent_at) {
    const lastSentKey = getLocalDateKey(new Date(business.last_digest_sent_at), timeZone);
    const todayKey = getLocalDateKey(now, timeZone);
    if (lastSentKey === todayKey) {
      return false;
    }
  }

  // Fire on the first invocation at or after the configured local time today.
  // Tolerant of any cron cadence (an exact minute match would miss most ticks).
  const parts = getTimeZoneParts(now, timeZone);
  const nowMinutes = parts.hour * 60 + parts.minute;
  const targetMinutes = targetHour * 60 + targetMinute;
  return nowMinutes >= targetMinutes;
}

async function markDigestSent(businessId) {
  const { error } = await supabaseService
    .from('businesses')
    .update({ last_digest_sent_at: new Date().toISOString() })
    .eq('id', businessId);

  if (error) {
    console.error('❌ Failed to mark digest sent:', error);
  }
}

function getPreviousDayRangeUtc(timeZone) {
  const now = new Date();
  const parts = getTimeZoneParts(now, timeZone);
  const endUtc = zonedTimeToUtc(timeZone, {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: 0,
    minute: 0,
    second: 0
  });
  const startUtc = new Date(endUtc.getTime() - 24 * 60 * 60 * 1000);
  const label = formatDate(startUtc, timeZone);

  return { startUtc, endUtc, label };
}

function getTodaySoFarRangeUtc(timeZone) {
  const now = new Date();
  const parts = getTimeZoneParts(now, timeZone);
  const startUtc = zonedTimeToUtc(timeZone, {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: 0,
    minute: 0,
    second: 0
  });
  const endUtc = now;
  const label = `${formatDate(startUtc, timeZone)} (today so far)`;
  return { startUtc, endUtc, label };
}

function getLast24HoursRangeUtc(timeZone) {
  const endUtc = new Date();
  const startUtc = new Date(endUtc.getTime() - 24 * 60 * 60 * 1000);
  const label = `Last 24 hours (ending ${formatDate(endUtc, timeZone)})`;
  return { startUtc, endUtc, label };
}

function getDigestRangeUtc(window, timeZone) {
  switch (window) {
    case 'today':
    case 'today-so-far':
      return getTodaySoFarRangeUtc(timeZone);
    case 'last24':
    case 'last-24-hours':
      return getLast24HoursRangeUtc(timeZone);
    case 'previous-day':
    default:
      return getPreviousDayRangeUtc(timeZone);
  }
}

function getTimeZoneParts(date, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });

  const parts = dtf.formatToParts(date);
  const map = {};
  for (const part of parts) {
    if (part.type !== 'literal') {
      map[part.type] = part.value;
    }
  }

  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    second: Number(map.second)
  };
}

function getTimeZoneOffset(date, timeZone) {
  const parts = getTimeZoneParts(date, timeZone);
  const asUTC = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  );
  return asUTC - date.getTime();
}

function zonedTimeToUtc(timeZone, parts) {
  const utcGuess = new Date(Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  ));
  const offset = getTimeZoneOffset(utcGuess, timeZone);
  return new Date(utcGuess.getTime() - offset);
}

function getLocalDateKey(date, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  const parts = dtf.formatToParts(date);
  const map = {};
  for (const part of parts) {
    if (part.type !== 'literal') {
      map[part.type] = part.value;
    }
  }
  return `${map.year}-${map.month}-${map.day}`;
}

function formatDate(date, timeZone) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  }).format(date);
}

function formatDateTime(dateString, timeZone) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  }).format(new Date(dateString));
}
