# Factory Clean technician scheduling

## Screens
- `/partners` — real staff portal; existing administrator login works. Technicians use their phone and a new strong password.
- `/partners/demo` — interactive sample data only; no authenticated client, writes, calls or notifications.
- `/book-technician` — public day-only booking. Initially closed until the administrator adds a technician and the technician sets cities, supported services and working hours.

## Workflow
Pending request -> explicit contact recorded -> customer-agreed date, time, estimated duration and price -> confirmed -> completed -> customer paid -> owner marks commission received. Source and the fixed 10% before-VAT commission are server-owned. History is appended transactionally. Only the owner can mark settlement.

Availability combines weekly hours, date overrides, time blocks, active 24-hour request holds, confirmed work, service duration and travel buffer. A shared PostgreSQL advisory transaction lock serializes scheduling changes and final reservations. Unanswered requests stay visible after the hold expires; confirmation always checks availability again. Request changes use version checks. Schedule changes that would hide an active hold or confirmed job are rejected.

No external notifications are sent; that channel was intentionally left for the owner and technician to select. The open dashboard refreshes every 30 seconds and on focus.

## Security and privacy
Supabase service credentials remain in server routes. Every staff request verifies the user against Supabase Auth and checks the current active profile/partner assignment. All new tables enable RLS, revoke anon/authenticated table privileges, and all mutation functions are SECURITY INVOKER with execute restricted to service_role. Customer endpoints expose only aggregate days and city names. Durable rate limits, input bounds, a honeypot and idempotency protect public requests. No real technician account or real customer request was created during development.

## Google Calendar
Owner can create/revoke a 256-bit calendar subscription URL in the Connections panel. Only the hash is stored. Google Calendar can subscribe once via Other calendars -> From URL on desktop. Feed changes are fetched on Google's polling schedule, not pushed in real time. This is a one-way display calendar; job changes are made in Factory OS. Event UID stays stable, SEQUENCE increases, cancelled jobs remain cancelled, pending requests are all-day tentative. Events are transparent so technician work does not block the owner's cleaning schedule. No customer names, phone numbers, exact addresses or commission details appear in the feed.

## Activation
1. Deploy this commit with the existing `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, and `SUPABASE_SECRET_KEY` (or legacy service-role key).
2. Migrations are applied to the existing `factory-clean-os` database. The unrelated marketing-site booking database was not modified.
3. Owner opens `/partners`, adds technician name/mobile/password. Technician's actual details have not been supplied yet.
4. Technician saves supported services, service cities, weekly hours and travel/working estimates, then enables booking.
5. Owner may add the calendar subscription to Google. Keep the generated URL private; regeneration revokes the prior URL.
6. Review the new booking page before pointing the marketing-site service choices at it. Existing marketing-site booking flows have not been changed.

## Verification
- `npm run test:partners`: Israel summer/winter/DST, ICS folding and escaping, status changes, calendar customer privacy.
- `tests/partner-scheduling.sql`: transactional rollback fixtures cover capacity, idempotency, contact prerequisite, stale updates, assignment isolation, blocked days/hours, settlement permissions and audit history.
- ESLint on changed module and full Next.js production build.
- Browser verification and deployed API checks are recorded separately after deployment.

## Current boundaries
Photo upload and a dedicated notification delivery provider are not connected in this first version. Customer can supply service details and share photos during the technician call. The existing marketing booking page remains unchanged pending review. First rollout is designed for one technician; the data model and owner filter support several technicians. Financial list is limited to the latest 2,000 requests; add paginated period reporting before that volume is reached.
