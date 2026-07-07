-- ============================================================
-- DEV SEED (not a migration — run manually after migrations 001–010)
--
-- Creates a single capture-mode test business and maps the VAPI/Twilio
-- number +1 (984) 600 7391 to it so getBusinessByPhone resolves on a call.
-- Safe to re-run (guards on existing rows).
-- ============================================================

-- Test business. appointment_handling_enabled MUST be true, otherwise the
-- webhook guard forces booking_mode='none' and capture mode never triggers.
insert into public.businesses
  (name, email, timezone, appointment_handling_enabled, booking_mode, ai_config)
select
  'HVAC Company',
  null,                       -- set an owner email here to receive per-call report emails
  'America/New_York',
  true,
  'capture',
  '{"vertical":"hvac"}'::jsonb
where not exists (
  select 1 from public.businesses where name = 'HVAC Company'
);

-- Map the phone number (E.164, no spaces/punctuation).
insert into public.business_phone_numbers
  (business_id, phone_number, label, is_primary)
select
  b.id, '+19846007391', 'HVAC Company Phone number', true
from public.businesses b
where b.name = 'HVAC Company'
  and not exists (
    select 1 from public.business_phone_numbers where phone_number = '+19846007391'
  );
