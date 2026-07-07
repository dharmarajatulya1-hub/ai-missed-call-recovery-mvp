-- ============================================================
-- Transcript sequencing fix (Phase 4.3)
--
-- The per-lambda in-memory sequence counter reset on every cold instance,
-- producing duplicate sequence numbers → unique-constraint collisions →
-- dropped transcript lines. We now insert with a NULL sequence and order by
-- spoken_at instead. That requires:
--   1. sequence_number nullable (it was NOT NULL).
--   2. Replace the (call_id, sequence_number) unique index — useless once
--      sequence is NULL — with a redelivery-dedup key on (call_id, spoken_at, role).
-- ============================================================

alter table public.call_transcripts
  alter column sequence_number drop not null;

drop index if exists public.uniq_call_transcripts_sequence;

create unique index if not exists uniq_call_transcripts_spoken
  on public.call_transcripts(call_id, spoken_at, role);
