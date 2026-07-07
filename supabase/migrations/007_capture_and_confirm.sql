-- ============================================================
-- Capture-and-confirm booking (Phase 2)
--
-- Adds a structured booking-request table for the default capture flow
-- (AI captures the request, owner confirms via the report channel) and an
-- explicit per-business booking mode. Existing Cal.com customers keep live
-- booking via the backfill below.
-- ============================================================

-- --------- booking_requests ---------
create table if not exists public.booking_requests (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,

  -- One request per call (mirrors bookings.uniq_booking_per_call).
  call_id uuid references public.calls(id) on delete set null,
  constraint uniq_booking_request_per_call unique (call_id),

  customer_name text not null,
  customer_phone text not null,
  customer_email text,

  service text not null,
  -- Array of natural-language windows the caller offered, e.g. ["Tue morning", "Thu after 3pm"].
  preferred_times jsonb not null,
  notes text,

  status text not null check (status in ('new','confirmed','declined','contacted')) default 'new',

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_booking_requests_business_created
on public.booking_requests(business_id, created_at desc);

create index if not exists idx_booking_requests_business_status
on public.booking_requests(business_id, status);

create trigger trg_booking_requests_updated_at
before update on public.booking_requests
for each row execute function public.update_updated_at_column();

-- --------- RLS (mirrors bookings) ---------
alter table public.booking_requests enable row level security;

create policy "booking_requests: select if member"
on public.booking_requests
for select
using (public.is_business_member(business_id));

create policy "booking_requests: insert if member"
on public.booking_requests
for insert
with check (public.is_business_member(business_id));

create policy "booking_requests: update if member"
on public.booking_requests
for update
using (public.is_business_member(business_id));

-- --------- businesses.booking_mode ---------
alter table public.businesses
  add column if not exists booking_mode text not null
    check (booking_mode in ('capture','live','callback','none')) default 'capture';

-- Existing Cal.com customers keep live booking.
update public.businesses
set booking_mode = 'live'
where calcom_enabled = true;

-- Preserve explicit opt-outs: a business that disabled appointment handling
-- must not be flipped into capture mode by the 'capture' default.
update public.businesses
set booking_mode = 'none'
where appointment_handling_enabled = false
  and calcom_enabled = false;
