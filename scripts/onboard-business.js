/*
  Onboard a business from a single JSON config file.

  This is the repeatable, one-shot onboarding tool: fill out one JSON file with
  everything about a business, run this, and it writes (idempotently) the
  `businesses` row + `business_phone_numbers` mapping (+ optional owner user)
  that the dynamic VAPI assistant reads on every call.

  Usage:
    SUPABASE_URL=... SUPABASE_SERVICE_KEY=... \
      node scripts/onboard-business.js path/to/business.json [--dry-run] [--preview]

  Flags:
    --dry-run   Validate + show exactly what would be written. No DB writes.
    --preview   Also print the assembled system prompt + first message this
                business's assistant will use (great sanity check before a call).

  Config shape: see scripts/business.example.json.

  Idempotent: matched by phone number. Re-running updates the existing business
  in place (so this doubles as an "edit a business" tool — tweak the JSON, re-run).
*/

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const PREVIEW = args.includes('--preview');
const configPath = args.find((a) => !a.startsWith('--'));

function fail(msg) {
  console.error(`\n❌ ${msg}\n`);
  process.exit(1);
}

if (!configPath) {
  fail('Provide a config file: node scripts/onboard-business.js business.json');
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
if (!DRY_RUN && !PREVIEW) {
  if (!SUPABASE_URL) fail('Missing SUPABASE_URL env');
  if (!SUPABASE_SERVICE_KEY) fail('Missing SUPABASE_SERVICE_KEY env');
}

// ---- Load config ----
let raw;
try {
  raw = fs.readFileSync(path.resolve(configPath), 'utf8');
} catch (err) {
  fail(`Cannot read config file "${configPath}": ${err.message}`);
}
let config;
try {
  config = JSON.parse(raw);
} catch (err) {
  fail(`Config is not valid JSON: ${err.message}`);
}

const biz = config.business || {};
const phoneCfg = config.phone || {};
const ownerCfg = config.owner || {};

// ---- Validation ----
const E164 = /^\+[1-9]\d{6,14}$/;
const VALID_BOOKING_MODES = ['capture', 'live', 'callback', 'none'];
const VALID_VOICE_PRESETS = ['sarah', 'rachel', 'adam', 'bella', 'alloy', 'tara'];

const errors = [];
if (!biz.name) errors.push('business.name is required');
if (!phoneCfg.number) errors.push('phone.number is required');
else if (!E164.test(phoneCfg.number)) errors.push(`phone.number "${phoneCfg.number}" must be E.164 (e.g. +19195551234)`);
if (biz.booking_mode && !VALID_BOOKING_MODES.includes(biz.booking_mode)) {
  errors.push(`business.booking_mode "${biz.booking_mode}" must be one of ${VALID_BOOKING_MODES.join(', ')}`);
}
const notifications = biz.notifications || {};
if (notifications.sms_report_enabled && !notifications.owner_notification_phone) {
  errors.push('notifications.sms_report_enabled is true but notifications.owner_notification_phone is missing');
}
if (notifications.owner_notification_phone && !E164.test(notifications.owner_notification_phone)) {
  errors.push(`notifications.owner_notification_phone "${notifications.owner_notification_phone}" must be E.164`);
}
const aiCfgIn = biz.ai || {};
if (aiCfgIn.voice_preset && !VALID_VOICE_PRESETS.includes(aiCfgIn.voice_preset)) {
  errors.push(`business.ai.voice_preset "${aiCfgIn.voice_preset}" must be one of ${VALID_VOICE_PRESETS.join(', ')}`);
}
if (errors.length) {
  fail(`Config problems:\n   - ${errors.join('\n   - ')}`);
}

// ---- Transform convenience fields → DB shapes ----

// Hours: accept "HH:MM-HH:MM" or "closed" per day → {start,end} | {closed:true}
function normalizeHours(hours) {
  if (!hours || typeof hours !== 'object') return undefined; // let DB default apply
  const out = {};
  for (const [day, val] of Object.entries(hours)) {
    const key = day.toLowerCase().slice(0, 3);
    if (!val || String(val).toLowerCase() === 'closed') {
      out[key] = { closed: true };
      continue;
    }
    const m = String(val).match(/^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/);
    if (!m) fail(`Hours for "${day}" must be "HH:MM-HH:MM" or "closed" (got "${val}")`);
    out[key] = { start: m[1], end: m[2] };
  }
  return out;
}

// ai_config jsonb: only include keys that were actually provided.
function buildAiConfig(ai) {
  const cfg = {};
  if (ai.vertical) cfg.vertical = ai.vertical;
  if (ai.voice_preset) cfg.voice_preset = ai.voice_preset;
  if (ai.personality) cfg.personality = ai.personality;
  if (ai.tone) cfg.tone = ai.tone;
  if (ai.model) cfg.model = ai.model;
  if (ai.silence_timeout) cfg.silence_timeout = ai.silence_timeout;
  if (ai.voice_params && typeof ai.voice_params === 'object') cfg.voice_params = ai.voice_params;
  if (ai.transcriber && typeof ai.transcriber === 'object') cfg.transcriber = ai.transcriber;
  return cfg;
}

// Build the businesses row. Undefined fields are dropped so DB defaults apply on
// insert; on update we only set what the config specifies.
function buildBusinessRow() {
  const row = {
    name: biz.name,
    email: biz.email ?? null,
    timezone: biz.timezone || 'America/New_York',
    services: Array.isArray(biz.services) ? biz.services : undefined,
    specialties: Array.isArray(biz.specialties) ? biz.specialties : undefined,
    ai_instructions: biz.ai_instructions ?? undefined,
    faq_data: biz.faq_data ?? undefined,
    custom_greeting: biz.custom_greeting ?? undefined,
    custom_closing: biz.custom_closing ?? undefined,
    booking_mode: biz.booking_mode || 'capture',
    appointment_handling_enabled: biz.appointment_handling_enabled ?? true,
    call_summary_email_enabled: notifications.call_summary_email_enabled ?? true,
    sms_report_enabled: notifications.sms_report_enabled ?? false,
    owner_notification_phone: notifications.owner_notification_phone ?? null,
    ai_config: buildAiConfig(aiCfgIn),
    vapi_assistant_id: phoneCfg.vapi_assistant_id ?? undefined,
    vapi_phone_number_id: phoneCfg.vapi_phone_number_id ?? undefined
  };
  const hours = normalizeHours(biz.hours);
  if (hours) row.business_hours = hours;
  // Strip undefined so we don't overwrite existing values with null on update.
  Object.keys(row).forEach((k) => row[k] === undefined && delete row[k]);
  return row;
}

const businessRow = buildBusinessRow();

console.log('\n📋 Onboarding config for:', biz.name);
console.log('   Phone:', phoneCfg.number);
console.log('   Booking mode:', businessRow.booking_mode, '| appointment handling:', businessRow.appointment_handling_enabled);
console.log('   Notifications: email=' + businessRow.call_summary_email_enabled + ' sms=' + businessRow.sms_report_enabled);
console.log('   Vertical:', aiCfgIn.vertical || '(inferred)', '| voice:', aiCfgIn.voice_preset || 'sarah (default)');

if (PREVIEW) {
  const { buildSystemPrompt, buildFirstMessage } = require('../lib/prompts/builders');
  const enableCapture = businessRow.booking_mode === 'capture';
  const enableBooking = businessRow.booking_mode === 'live';
  const enableCallback = businessRow.booking_mode === 'callback';
  const opts = {
    enableCapture,
    enableBooking,
    enableCallback,
    appointmentHandlingEnabled: businessRow.appointment_handling_enabled
  };
  const previewBiz = { ...businessRow, services: businessRow.services || [], specialties: businessRow.specialties || [] };
  console.log('\n──────── FIRST MESSAGE ────────\n' + buildFirstMessage(previewBiz, opts));
  console.log('\n──────── SYSTEM PROMPT ────────\n' + buildSystemPrompt(previewBiz, opts) + '\n');
}

if (DRY_RUN || PREVIEW) {
  console.log('\n🔎 Row that would be written:\n', JSON.stringify(businessRow, null, 2));
  if (DRY_RUN) console.log('\n✅ Dry run — no database writes performed.\n');
  if (!DRY_RUN) process.exit(0);
  process.exit(0);
}

// ---- Write to DB ----
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

async function findBusinessIdByPhone(number) {
  const { data, error } = await supabase
    .from('business_phone_numbers')
    .select('business_id')
    .eq('phone_number', number)
    .maybeSingle();
  if (error) throw error;
  return data?.business_id || null;
}

async function ensureOwnerUserId() {
  if (ownerCfg.user_id) return ownerCfg.user_id;
  if (!ownerCfg.email || !ownerCfg.password) return null;
  const { data, error } = await supabase.auth.admin.createUser({
    email: ownerCfg.email,
    password: ownerCfg.password,
    email_confirm: true
  });
  if (error) {
    console.warn('⚠️  Could not create owner auth user:', error.message);
    return null;
  }
  return data?.user?.id || null;
}

async function main() {
  const existingId = await findBusinessIdByPhone(phoneCfg.number);

  let business;
  if (existingId) {
    const { data, error } = await supabase
      .from('businesses')
      .update(businessRow)
      .eq('id', existingId)
      .select()
      .single();
    if (error) throw error;
    business = data;
    console.log(`\n♻️  Updated existing business ${business.id} (${business.name})`);
  } else {
    const { data, error } = await supabase
      .from('businesses')
      .insert(businessRow)
      .select()
      .single();
    if (error) throw error;
    business = data;
    console.log(`\n✨ Created business ${business.id} (${business.name})`);
  }

  const { data: phoneRow, error: phoneErr } = await supabase
    .from('business_phone_numbers')
    .upsert({
      business_id: business.id,
      phone_number: phoneCfg.number,
      label: phoneCfg.label || 'main',
      twilio_phone_number_sid: phoneCfg.twilio_sid || null,
      vapi_phone_number_id: phoneCfg.vapi_phone_number_id || null,
      is_primary: true,
      active: true
    }, { onConflict: 'phone_number' })
    .select()
    .single();
  if (phoneErr) throw phoneErr;
  console.log(`📞 Mapped ${phoneRow.phone_number} → ${business.id}`);

  const ownerId = await ensureOwnerUserId();
  if (ownerId) {
    const { error: linkErr } = await supabase
      .from('business_users')
      .upsert({ business_id: business.id, user_id: ownerId, role: 'owner' }, { onConflict: 'business_id,user_id' });
    if (linkErr) throw linkErr;
    console.log(`👤 Linked owner user ${ownerId}`);
  }

  console.log('\n✅ Onboarding complete. Business ID:', business.id);
  console.log('   Next: point this number to VAPI, set up call forwarding, then place a test call.');
  console.log('   (See docs/ONBOARDING-RUNBOOK.md)\n');
}

main().catch((err) => {
  console.error('\n❌ Onboarding failed:', err.message || err);
  process.exit(1);
});
