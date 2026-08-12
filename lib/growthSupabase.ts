// lib/growthSupabase.ts
//
// Minimal, insert-only Supabase client for growth_events. This is the ONLY
// file in either repo that ever writes to growth_events, and this file (via
// app/api/growth-ingest/route.ts) is the ONLY caller that ever runs
// server-side with Factory OS's real database credentials for this
// feature - see the Sprint 1 architecture discussion: the marketing site
// forwards here specifically so it never has to hold this key itself.
//
// Uses @supabase/supabase-js (already a dependency of this project - see
// package.json and lib/supabase.ts) rather than a hand-rolled fetch/REST
// client. Note this is a DELIBERATE difference from the marketing site's
// lib/supabase.js, which hand-rolls REST calls only because the sandbox
// that originally wrote it had no npm registry access - that constraint
// does not apply here, and this project already uses the real SDK
// everywhere else (lib/supabase.ts, app/api/admin/create-employee/route.ts),
// so this file follows that existing convention instead.
//
// Required environment variables - same names already used by
// app/api/admin/create-employee/route.ts, so if that route already works
// in production, these are very likely already set on this Vercel project
// and nothing new needs to be added:
//   NEXT_PUBLIC_SUPABASE_URL      (already public/non-secret - safe to
//                                   reuse server-side too, exactly as
//                                   create-employee/route.ts already does)
//   SUPABASE_SECRET_KEY           (falls back to SUPABASE_SERVICE_ROLE_KEY
//                                   for the same reason lib/supabase.ts and
//                                   create-employee/route.ts both check
//                                   both names - Supabase renamed this key
//                                   type after some of this code was
//                                   originally written; see lib/supabase.ts)
//
// Read lazily (inside getAdminClient(), not at module load) so a missing
// env var throws a clear, specific error at the point of use rather than
// crashing cold-start - same pattern as every lib/*.js file in the
// marketing site repo and as create-employee/route.ts itself.

import { createClient } from "@supabase/supabase-js";

function getAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secretKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !secretKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SECRET_KEY (or SUPABASE_SERVICE_ROLE_KEY) environment variables",
    );
  }
  return createClient(url, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

// Deliberately has NO customer_id / job_id fields - Sprint 1 does not link
// browser events to Factory OS records (booking_ref is the only bridge for
// now, per the approved scope). Keeping them out of this type entirely
// means there is no code path in this file that could ever write a
// caller-supplied customer_id/job_id, even by accident - a second layer of
// the same guarantee app/api/growth-ingest/route.ts already enforces by
// never reading those keys from the request body.
export type GrowthEventRow = {
  client_event_id: string;
  event_name: string;
  event_origin: string;
  session_id: string;
  anonymous_id: string;
  page_path: string | null;
  service_type: string | null;
  booking_step: string | null;
  step_number: number | null;
  cta_location: string | null;
  device_type: string | null;
  city: string | null;
  booking_ref: string | null;
  first_source: string | null;
  first_medium: string | null;
  first_campaign: string | null;
  first_campaign_id: string | null;
  first_content: string | null;
  first_term: string | null;
  first_referrer: string | null;
  landing_path: string | null;
  current_source: string | null;
  current_medium: string | null;
  current_campaign: string | null;
  current_campaign_id: string | null;
  current_content: string | null;
  current_term: string | null;
  current_referrer: string | null;
  value: number | null;
  currency: string | null;
  metadata: Record<string, unknown>;
};

export type InsertGrowthEventResult =
  | { ok: true; deduped: boolean }
  | { ok: false; error: string };

// Idempotent insert: growth_events.client_event_id has a UNIQUE index (set
// up in the migration run directly in Supabase's SQL Editor - "Success. No
// rows returned"). A duplicate delivery - the tracker's own one-shot
// fetch retry, or any future server-side retry - reuses the SAME
// client_event_id, so Postgres rejects the second insert with a
// unique_violation (Postgres code 23505). That is treated as success, not
// an error: the event is already safely recorded, exactly once.
export async function insertGrowthEvent(row: GrowthEventRow): Promise<InsertGrowthEventResult> {
  const client = getAdminClient();
  const { error } = await client.from("growth_events").insert(row);

  if (!error) return { ok: true, deduped: false };
  if (error.code === "23505") return { ok: true, deduped: true };
  return { ok: false, error: error.message };
}
