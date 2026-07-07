-- ============================================================
-- Post-call report flags (Phase 3)
--
-- Per-call summary email is on by default; SMS reports are an opt-in paid
-- add-on delivered from the platform toll-free number.
-- ============================================================

alter table public.businesses
  add column if not exists call_summary_email_enabled boolean not null default true;

alter table public.businesses
  add column if not exists sms_report_enabled boolean not null default false;

alter table public.businesses
  add column if not exists owner_notification_phone text;
