# Onboarding a New Business — Runbook

Goal: take a new local business live on Svaraa in ~15 minutes, repeatably. The whole
thing reduces to **one JSON file + one command + two Twilio settings**.

Working example throughout: the demo business **HVAC Company** on **+1 (984) 600‑7391**.

---

## The mental model (why this is simple)

There is **one** VAPI assistant for the entire platform. It does not know about any
specific business until a call comes in. On each call:

```
Caller dials the business's Twilio number
  → Twilio hits  POST /api/webhook   (this app)
  → app asks VAPI to run the call (passing the raw Twilio number)
  → VAPI calls back POST /api/vapi-webhook  "assistant-request"
  → app looks up the business by the number that was called
     (business_phone_numbers → businesses)
  → builds THAT business's prompt/voice/booking-mode from its DB row
  → conversation runs; lead/booking saved; owner notified
```

So onboarding a business = **(a) get a phone number pointed at us, and (b) write that
business's row in the database.** That's it. No per‑business assistant, no VAPI dashboard
work, no code changes.

---

## What to collect from the customer (the intake checklist)

Everything here maps 1:1 to a field in the config file (`scripts/business.example.json`):

- **Business name** (exact, as they want it spoken)
- **Owner email** — where call summaries go
- **Owner mobile** (E.164, e.g. `+19195551234`) — for SMS alerts later
- **Timezone** (e.g. `America/New_York`)
- **Services** they offer (list)
- **Hours** (per day, or "closed")
- **Greeting** preference (or use the default)
- **Anything the AI must know** — service area, what they DON'T do, pricing rules → `ai_instructions`
- **Common FAQs** → `faq_data`
- **Vertical** (`hvac`, `dental`, or leave blank for general) — drives industry handling
- **Their existing business phone number** (the one customers already call)

---

## Step 1 — Get a phone number pointed at us

You have two options. **Forwarding is the fast path; porting is cleaner long‑term.**

### Option A (recommended to start): new Twilio number + call forwarding
1. **Buy a Twilio number** for the business (local to their area code):
   Twilio Console → Phone Numbers → Buy a number → Voice capability → buy (~$1.15/mo).
2. **Point its voice webhook at us.** On that number's config page, under
   **Voice → A call comes in**, set:
   - Type: **Webhook**
   - URL: `https://<your-mvp-domain>/api/webhook`  ← e.g. the MVP Vercel prod URL
   - Method: **HTTP POST**
   Save. (This is the same endpoint the demo number uses.)
3. **Set call forwarding on the customer's existing line** so missed calls roll to the
   Twilio number. This is what makes it "missed‑call recovery":
   - **Forward on no‑answer / busy** (conditional) is the usual setup — their phone rings
     first, and only unanswered calls reach Svaraa.
   - Codes are **carrier‑specific**; confirm with their carrier. Common US GSM codes:
     - Forward when unanswered: `*61*<TwilioNumber>#`
     - Forward when busy: `*67*<TwilioNumber>#`
     - Forward when unreachable: `*62*<TwilioNumber>#`
     - Forward ALL calls: `*72<TwilioNumber>` (cancel: `*73`)
   - On landlines/VoIP (RingCentral, Spectrum, etc.) it's a setting in their portal, not a
     code — "Forward on no answer → <Twilio number>".

### Option B (later): port their number
Port the customer's existing number into Twilio so Svaraa answers directly with no
forwarding. Slower (days) and irreversible‑ish; do this once they're committed.

> Only calls that actually reach the Twilio number are handled by Svaraa. With conditional
> forwarding, the owner still gets first crack at every call.

---

## Step 2 — Seed the business row (one command)

1. Copy the template and fill it in:
   ```bash
   cp scripts/business.example.json /tmp/<business>.json
   # edit /tmp/<business>.json with the intake details
   ```
2. Dry‑run first to validate + see the exact prompt this business will use — **no DB writes**:
   ```bash
   node scripts/onboard-business.js /tmp/<business>.json --preview
   ```
   This prints the assembled first message + system prompt. Read it. If the greeting,
   hours, services, and booking language look right, proceed.
3. Write it to the database:
   ```bash
   SUPABASE_URL=https://<ref>.supabase.co \
   SUPABASE_SERVICE_KEY=<service-role-key> \
     node scripts/onboard-business.js /tmp/<business>.json
   ```
   The script is **idempotent** — matched by phone number. Re‑running updates the business
   in place, so it doubles as your "edit a business" tool: change the JSON, re‑run.

What it writes:
- `businesses` row (name, hours, services, booking mode, notifications, `ai_config`, …)
- `business_phone_numbers` mapping (the Twilio number → this business)
- optionally a `business_users` owner login (if you set `owner.email`/`owner.password`)

> **Getting the SUPABASE_SERVICE_KEY:** it lives in the MVP Vercel project's env
> (Settings → Environment Variables) as a Sensitive value. Copy it into the command above,
> or export it in your shell for the session. Never commit it.

---

## Step 3 — Notifications

- **Email (default on):** set the owner's address in `business.email` (in the JSON). Per‑call
  summaries send automatically once `RESEND_API_KEY` + a verified `EMAIL_FROM` are configured
  in the MVP project. (Domain `svaraa.co` must be verified in Resend to email real customers.)
- **SMS (opt‑in, later):** set `notifications.sms_report_enabled: true` +
  `notifications.owner_notification_phone`. Requires the toll‑free number to finish
  verification first — see `~/Documents/Svaraa/TOLLFREE-SMS-VERIFICATION.md`.

---

## Step 4 — Test call (acceptance)

1. **Call the Twilio number directly** (skip forwarding for the test) and run a short
   scenario: "Hi, I'd like to book a repair for Tuesday morning, my name is…".
2. The assistant should: greet with the business name, capture service + time + name +
   phone, read the phone back digit‑by‑digit, and say the team will call to confirm.
3. **Verify the data landed:**
   - a row in `calls` (with `summary`, `sentiment`, `duration_seconds`, recording URL)
   - a row in `booking_requests` (service, preferred_times, name, phone)
   - a per‑call **email** in the owner's inbox (if email is configured)
4. **Test forwarding** separately: call the customer's real line, let it ring out, confirm
   it rolls to Svaraa.

If any step fails, check the Vercel function logs for `/api/webhook` and `/api/vapi-webhook`.

---

## The fast path ("give me the details")

Because the whole thing is one JSON file, onboarding can be nearly hands‑off:

1. You hand over the intake details (business name, hours, services, owner email/phone,
   their existing number, vertical).
2. I fill in `scripts/business.example.json` → a per‑business config, run the seeder
   (`--preview` first so you can approve the prompt, then the real write).
3. You do the two things only an account holder can: **buy the Twilio number** and **set the
   forwarding** on the customer's line.
4. We place the acceptance test call together.

---

## Config field reference

| Config path | DB column | Notes |
|---|---|---|
| `business.name` | `name` | Spoken in greeting + prompt |
| `business.email` | `email` | Per‑call summary recipient |
| `business.timezone` | `timezone` | Resolves "today/tomorrow", hours |
| `business.services[]` | `services` | Listed as the business's services |
| `business.specialties[]` | `specialties` | Extra emphasis |
| `business.hours` | `business_hours` | `"HH:MM-HH:MM"` or `"closed"` per day |
| `business.custom_greeting` | `custom_greeting` | `{{businessName}}` allowed |
| `business.custom_closing` | `custom_closing` | Optional |
| `business.ai_instructions` | `ai_instructions` | Reference notes (not rules) |
| `business.faq_data` | `faq_data` | Freeform Q/A text |
| `business.booking_mode` | `booking_mode` | `capture` (default) / `live` / `callback` / `none` |
| `business.appointment_handling_enabled` | `appointment_handling_enabled` | `false` → assistant won't schedule |
| `business.notifications.call_summary_email_enabled` | `call_summary_email_enabled` | Default true |
| `business.notifications.sms_report_enabled` | `sms_report_enabled` | Needs verified toll‑free number |
| `business.notifications.owner_notification_phone` | `owner_notification_phone` | E.164, for SMS |
| `business.ai.vertical` | `ai_config.vertical` | `hvac` / `dental` / blank → industry handling |
| `business.ai.voice_preset` | `ai_config.voice_preset` | `sarah` (default), `rachel`, `adam`, … |
| `business.ai.personality` / `tone` | `ai_config.*` | Prompt persona overrides |
| `business.ai.model` | `ai_config.model` | e.g. `gpt-4o` to override `gpt-4o-mini` |
| `phone.number` | `business_phone_numbers.phone_number` | The Twilio number (E.164) |
| `phone.twilio_sid` | `…twilio_phone_number_sid` | Optional bookkeeping |

---

## Quick reference — the demo business

- **Name:** HVAC Company
- **Number:** +1 (984) 600‑7391  (`+19846007391`)
- **Mode:** capture‑and‑confirm, appointment handling on, vertical `hvac`
- **Voice:** Sarah (11labs)
- Use this as the reference config when filling out a new business.
