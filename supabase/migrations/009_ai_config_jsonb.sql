-- ============================================================
-- Consolidated per-business AI config (Phase 4.2)
--
-- Single JSONB override surface for assistant tuning. Empty by default so
-- existing businesses are unaffected; builders fall back to code constants.
--
-- Recognized keys:
--   { vertical, personality, tone, voice_preset, voice_params,
--     model, temperature, max_tokens, silence_timeout }
-- ============================================================

alter table public.businesses
  add column if not exists ai_config jsonb not null default '{}'::jsonb;
