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

  const keyCalls = calls.slice(0, 5).map((call) => {
    const time = formatDateTime(call.created_at, timeZone);
    const from = call.from_phone || call.customer_phone || 'unknown';
    const summary = call.summary ? call.summary.slice(0, 140) : 'No summary';
    return `${time} | ${from} | ${call.status || 'unknown'} | ${summary}`;
  });

  const text = [
    `Daily Call Digest for ${business.name}`,
    `Date: ${label} (${timeZone})`,
    '',
    `Total calls: ${stats.total}`,
    `Missed calls: ${stats.missed}`,
    `Top intents: ${topIntents || 'None'}`,
    '',
    'Key calls:',
    keyCalls.length ? keyCalls.join('\n') : 'No calls recorded.',
    '',
    dashboardLink ? `Dashboard: ${dashboardLink}` : ''
  ].filter(Boolean).join('\n');

  const tableRows = keyCalls.length
    ? keyCalls.map((c) => {
        const [time, from, status, summary] = c.split(' | ');
        return `
          <tr>
            <td style="padding: 8px; border-bottom: 1px solid #eee;">${escapeHtml(time || '')}</td>
            <td style="padding: 8px; border-bottom: 1px solid #eee;">${escapeHtml(from || '')}</td>
            <td style="padding: 8px; border-bottom: 1px solid #eee;">${escapeHtml(status || '')}</td>
            <td style="padding: 8px; border-bottom: 1px solid #eee;">${escapeHtml(summary || '')}</td>
          </tr>
        `;
      }).join('')
    : `
      <tr>
        <td colspan="4" style="padding: 8px; text-align: center; color: #666;">No calls recorded.</td>
      </tr>
    `;

  const html = `
    <div style="font-family: Arial, sans-serif; color: #111; line-height: 1.5;">
      <h2 style="margin-bottom: 4px;">Daily Call Digest</h2>
      <p style="margin: 0;"><strong>${escapeHtml(business.name)}</strong></p>
      <p style="margin-top: 4px;">Date: ${escapeHtml(label)} (${escapeHtml(timeZone)})</p>
      <hr />
      <div style="display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin-bottom: 16px;">
        <div style="background: #f8f8f8; padding: 10px; border-radius: 8px;">
          <div style="font-size: 12px; color: #666;">Total Calls</div>
          <div style="font-size: 20px; font-weight: 700;">${stats.total}</div>
        </div>
        <div style="background: #f8f8f8; padding: 10px; border-radius: 8px;">
          <div style="font-size: 12px; color: #666;">Missed Calls</div>
          <div style="font-size: 20px; font-weight: 700;">${stats.missed}</div>
        </div>
        <div style="background: #f8f8f8; padding: 10px; border-radius: 8px;">
          <div style="font-size: 12px; color: #666;">Top Intents</div>
          <div style="font-size: 14px; font-weight: 600;">${escapeHtml(topIntents || 'None')}</div>
        </div>
      </div>
      <h3 style="margin-bottom: 8px;">Key calls</h3>
      <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
        <thead>
          <tr style="text-align: left; background: #fafafa;">
            <th style="padding: 8px; border-bottom: 1px solid #eee;">Time</th>
            <th style="padding: 8px; border-bottom: 1px solid #eee;">Caller</th>
            <th style="padding: 8px; border-bottom: 1px solid #eee;">Status</th>
            <th style="padding: 8px; border-bottom: 1px solid #eee;">Summary</th>
          </tr>
        </thead>
        <tbody>
          ${tableRows}
        </tbody>
      </table>
      ${dashboardLink ? `<p style="margin-top: 16px;"><a href="${dashboardLink}">Open dashboard</a></p>` : ''}
    </div>
  `;

  return { to: recipient, subject, html, text };
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
