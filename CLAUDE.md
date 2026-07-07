# Svaraa (ai-missed-call-recovery-mvp)

AI phone answering for local small businesses (vet, salon, auto, HVAC — NOT dental/medspa as HIPAA verticals). ~4 paying customers at $199–299/mo. Posture: **maintain, don't scale** — prefer small, safe changes over rebuilds. Do not break the live Cal.com booking path for businesses with `calcom_enabled=true`.

## Roadmap — read this first

The authoritative, phased implementation plan (security fixes → call-quality fixes → capture-and-confirm booking → reports → hardening) lives at:

**`/Users/gilfoyle/Documents/Svaraa/MVP-MARKET-READY-PLAN.md`**

When asked to "implement Phase N," follow that document exactly — it has file:line targets, exact prompt text, and acceptance criteria per work item. Architecture rationale: vault note `SecondBrain/20-Projects/svaraa/architecture-plan-2026-07.md`.

## Architecture (live call flow)

```
Caller → Twilio number → api/webhook.js  (validates Twilio sig, forwards to VAPI /call
                                          with provider bypass, returns VAPI's TwiML)
        VAPI runs the conversation, sends events to api/vapi-webhook.js:
          assistant-request → per-business assistant config built from Supabase
                              (lib/vapi/index.js + lib/prompts/*)
          tool-calls        → executeFunctionCall → Cal.com (lib/calcom.js) / DB
          transcript        → call_transcripts
          end-of-call-report→ calls (summary, transcript, recording_url)
        api/cron/daily-digest.js → Resend digest email (raw fetch, no SDK)
```

- **Dynamic assistant pattern**: one webhook serves all businesses; lookup by called number via `business_phone_numbers` → `businesses` (`lib/supabase.js:getBusinessByPhone`). Never create per-business assistants in the VAPI dashboard.
- **DB is Supabase** (service-role key server-side; RLS exists but only matters for a future anon-key dashboard). Tables: `businesses` (config spread across flat columns + `ai_config` jsonb override surface), `business_phone_numbers`, `business_users`, `calls`, `call_transcripts`, `bookings` (live Cal.com bookings), `booking_requests` (capture-and-confirm requests), `business_integrations` (Cal.com OAuth tokens).
- **Booking mode** is driven by `businesses.booking_mode` (`capture` default | `live` | `callback` | `none`), resolved in `handleAssistantRequest`. `live` requires a valid Cal.com token or it degrades to `capture`. Capture mode uses the `captureBookingRequest` tool → `booking_requests`; live mode uses `checkAvailability`/`createBooking` → Cal.com + `bookings`.
- **Cal.com is v2 OAuth2** (`lib/calcom.js`), gated by `booking_mode='live'` + stored token (existing `calcom_enabled` rows were backfilled to `live` in migration 007). Legacy/opt-in only; Nylas is the future sync provider if ever needed.
- **Assistant stack defaults** (`lib/vapi/index.js`, overridable per-business via `ai_config`): transcriber Deepgram `nova-3`; model OpenAI `gpt-4o-mini` (temp 0.2, maxTokens 240); voice 11labs **Sarah** (`eleven_turbo_v2_5`, pinned prosody). An `analysisPlan` populates `analysis.structuredData` → `calls.sentiment`/`intent`.

## Conventions

- Plain JS Vercel serverless functions. No TypeScript, no frameworks, no new dependencies without explicit approval (Resend is called via raw `fetch` on purpose).
- Schema changes = new numbered migration in `supabase/migrations/`; never edit an applied migration.
- Webhook handlers return `200 { received: true }` even on internal failure (prevents VAPI retry storms); `assistant-request` falls back to `buildDefaultConfig()` on error.
- Prompt content lives in `lib/prompts/templates.js` (text) + `lib/prompts/builders.js` (assembly). Preview with `api/debug/prompt-preview.js` (`DEBUG_SECRET`-gated).

## Fixed in the Phase 0–4 build-out (2026-07-06)

Plan Phases 0–4 are implemented (migrations 007–009 add `booking_requests`, `booking_mode`, report flags, `ai_config`). Resolved former landmines: VAPI webhook now requires `x-vapi-secret`; Twilio sig fails closed; `prompt-preview` fails closed on unset `DEBUG_SECRET`; the unauthenticated `debug/test-calcom` + `calcom/availability` + `calcom/book` endpoints were deleted; timezone reads `businesses.timezone` everywhere; `custom_greeting` is live; `endCallPhrases` no longer contains bare `'Goodbye'`/`'Take care'`; transcript sequencing uses NULL + `spoken_at` (no in-memory Map); `scheduleCallback` + `captureBookingRequest` persist to `booking_requests`; `vercel.json` has the digest cron; `analysisPlan` is set; `ai_config` exists; dead pre-VAPI files removed.

## Shipped 2026-07-07 (session 2)

Infra + polish on top of Phase 0–4. New Supabase project (`lsouhkcmzgsbejtvsefo`) migrated (001–010) + seeded (HVAC test business on `+19846007391`); Vercel prod env set. Migration 010 made transcript `sequence_number` nullable. Duration/phone-capture fix merged (PR #3, `d1da9b0`).

- **Email is live to real customers.** Resend sending domain `send.svaraa.co` verified (DKIM/SPF/MX at Namecheap; root kept on PrivateEmail); `EMAIL_FROM=Svaraa <notifications@send.svaraa.co>` (was the `onboarding@resend.dev` test sender, which only reached the account owner).
- **Per-call email redesigned** (branded HTML) with the "Duration: n/a" bug fixed (`sendCallReports` now takes the message-level `durationSeconds` instead of recomputing from the minimal `call` object) and phone numbers formatted. **Merged (PR #4, `8372af6`) but NOT yet deployed to prod** — the redesign + duration-in-email fix go live only on the next `vercel --prod`.
- **Onboarding is one JSON + one command:** `scripts/onboard-business.js` (config-driven, idempotent by phone, `--dry-run`/`--preview`) + `scripts/business.example.json` + `docs/ONBOARDING-RUNBOOK.md`.
- **Toll-free SMS submitted:** platform number `+18448412214` purchased; toll-free verification filed, in carrier review (~1–4 wks). SMS code stays flag-gated (`sms_report_enabled`) until it clears.
- **Landing site** (`svaraa.co`, separate repo `dharmarajatulya1-hub/ai-missed-call-recovery`, **CLI-deployed via `vercel --prod`, not git auto-deploy**) now has `/privacy`, `/terms`, an SMS consent checkbox on the signup form, and an `/optin` opt-in-proof page.

## Remaining landmines / watch-items

- **PR #4 is merged but prod is not redeployed** — the branded email + duration-in-email fix are on `main` only. Run `vercel --prod` in the MVP repo to ship them. `EMAIL_FROM` must stay on the verified `send.svaraa.co` domain or real-customer sends break.

- **`VAPI_WEBHOOK_SECRET` is now required.** The webhook fails closed — if it is unset in Vercel env **and** the VAPI dashboard Server settings, every call breaks. Same for `PUBLIC_BASE_URL` (per-assistant server URL) and `DEBUG_SECRET` (prompt-preview).
- **Model is `gpt-4o-mini`** (chosen for cost/latency). Weaker function-calling than `gpt-4o`; if live Cal.com calls mis-loop on `checkAvailability`, bump those rows via `ai_config.model='gpt-4o'`. Tool-use rules + 2-call cap are the mitigation.
- `lib/calcom.js:resolveBookingStartTime` still hardcodes `APP_TIME_ZONE` for wall-clock slot matching (not threaded to `business.timezone`) — only matters if a *live* Cal.com business is outside America/New_York (none today).
- `calcom/oauth.js` uses an **unsigned base64 `state`** — a known target business UUID + a completed OAuth flow could bind an attacker's Cal.com to it. Sign with HMAC before onboarding via a public link.
- Migration `005` bakes a seed `UPDATE ... WHERE name='XYZ HVAC Company'` into DDL — don't repeat that pattern.
- Booking idempotency is a pre-check on `bookings.call_id`; truly concurrent duplicate `tool-calls` can still race before the first row commits (rare). Unique-violation on persist is now treated as already-booked.

## Verification

After any change to the call path, run the smoke test at the bottom of the plan doc: capture-mode call, live-mode (Cal.com) regression call, per-call report delivery, forged-webhook 401, digest idempotency.
