// app/api/growth-ingest/route.ts
//
// POST /api/growth-ingest
//
// The ONLY place in either repo that writes to growth_events. Called
// server-to-server by the marketing site's api/track.js - never called
// directly by any browser, and never linked from any client-side code.
// Authenticated by a shared secret (GROWTH_INGEST_SECRET) compared with
// crypto.timingSafeEqual, not by a logged-in admin session, since the
// caller here is another server, not a person - mirrors the reasoning in
// the marketing site's lib/approvalToken.js (never a plain === on a
// secret-derived value).
//
// This route is intentionally the SOLE holder of Factory OS's real
// Supabase service-role key for growth tracking (via lib/growthSupabase.ts)
// - see the Sprint 1 architecture approval: the marketing site never
// receives this key, only GROWTH_INGEST_SECRET, which grants nothing
// beyond "may call this one endpoint."
//
// Follows this project's own existing Route Handler convention (see
// app/api/admin/create-employee/route.ts) rather than a standalone Vercel
// /api/*.js function - this project is a normal Next.js App Router app
// with its own server routes already (create-employee/route.ts is live
// proof), not a static export, so there is no reason to reach for a
// different deployment shape here.
//
// Validates independently against the FULL 12-name event allowlist
// (unlike api/track.js's 10-name browser-only allowlist) because this
// endpoint is the one place job_completed/revenue_recorded could
// legitimately arrive from in a future phase (a server-side caller inside
// Factory OS itself, not the browser) - see growth-tracker.js's own
// comment on why it excludes those two names.
//
// Response contract:
//   200 { ok:true, deduped:boolean }  - inserted (or already present via
//                                        the same client_event_id - see
//                                        lib/growthSupabase.ts)
//   400 { error }                     - malformed request
//   401 { error }                     - missing/wrong bearer secret
//   500 { error }                     - not configured, or the insert
//                                        itself failed

import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { insertGrowthEvent, type GrowthEventRow } from "@/lib/growthSupabase";

const ALLOWED_EVENT_NAMES = new Set([
  "page_view",
  "service_view",
  "price_view",
  "before_after_interaction",
  "whatsapp_click",
  "phone_click",
  "booking_started",
  "booking_step_completed",
  "booking_submitted",
  "booking_confirmed",
  "job_completed",
  "revenue_recorded",
]);

const ALLOWED_EVENT_ORIGINS = new Set(["web", "os", "system"]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Never a plain === on a secret-derived value (timing side-channel) - same
// reasoning as lib/approvalToken.js's verify() in the marketing site repo.
// When lengths differ, still runs timingSafeEqual against a same-length
// buffer so response time doesn't leak the correct secret's length either.
function secretMatches(provided: string, expected: string): boolean {
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  if (providedBuf.length !== expectedBuf.length) {
    crypto.timingSafeEqual(providedBuf, providedBuf);
    return false;
  }
  return crypto.timingSafeEqual(providedBuf, expectedBuf);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value.slice(0, 500) : null;
}
function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export async function POST(request: NextRequest) {
  try {
    const expectedSecret = process.env.GROWTH_INGEST_SECRET;
    if (!expectedSecret) {
      console.error("[growth-ingest] GROWTH_INGEST_SECRET is not configured");
      return NextResponse.json({ error: "Not configured" }, { status: 500 });
    }

    const authorization = request.headers.get("authorization");
    const provided = authorization?.startsWith("Bearer ") ? authorization.slice(7) : null;
    if (!provided || !secretMatches(provided, expectedSecret)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: "Invalid body" }, { status: 400 });
    }

    const eventName = str(body.event_name);
    if (!eventName || !ALLOWED_EVENT_NAMES.has(eventName)) {
      return NextResponse.json({ error: "Invalid or missing event_name" }, { status: 400 });
    }

    const clientEventId = str(body.client_event_id);
    if (!clientEventId || !UUID_RE.test(clientEventId)) {
      return NextResponse.json({ error: "Invalid or missing client_event_id" }, { status: 400 });
    }

    const sessionId = str(body.session_id);
    const anonymousId = str(body.anonymous_id);
    if (!sessionId || !anonymousId) {
      return NextResponse.json({ error: "Missing session_id or anonymous_id" }, { status: 400 });
    }

    const eventOriginRaw = str(body.event_origin);
    const eventOrigin = eventOriginRaw && ALLOWED_EVENT_ORIGINS.has(eventOriginRaw) ? eventOriginRaw : "web";

    // customer_id / job_id are NEVER read from the request body, even if
    // present - Sprint 1 does not accept a caller-asserted link to Factory
    // OS records from any source, including api/track.js. Enforced again
    // at the type level by GrowthEventRow, which has no such fields.
    const row: GrowthEventRow = {
      client_event_id: clientEventId,
      event_name: eventName,
      event_origin: eventOrigin,
      session_id: sessionId,
      anonymous_id: anonymousId,
      page_path: str(body.page_path),
      service_type: str(body.service_type),
      booking_step: str(body.booking_step),
      step_number: num(body.step_number),
      cta_location: str(body.cta_location),
      device_type: str(body.device_type),
      city: str(body.city),
      booking_ref: str(body.booking_ref),
      first_source: str(body.first_source),
      first_medium: str(body.first_medium),
      first_campaign: str(body.first_campaign),
      first_campaign_id: str(body.first_campaign_id),
      first_content: str(body.first_content),
      first_term: str(body.first_term),
      first_referrer: str(body.first_referrer),
      landing_path: str(body.landing_path),
      current_source: str(body.current_source),
      current_medium: str(body.current_medium),
      current_campaign: str(body.current_campaign),
      current_campaign_id: str(body.current_campaign_id),
      current_content: str(body.current_content),
      current_term: str(body.current_term),
      current_referrer: str(body.current_referrer),
      value: num(body.value),
      currency: str(body.currency) || "ILS",
      metadata: body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
        ? (body.metadata as Record<string, unknown>)
        : {},
    };

    const result = await insertGrowthEvent(row);
    if (!result.ok) {
      console.error("[growth-ingest] insert failed:", result.error);
      return NextResponse.json({ error: "Insert failed" }, { status: 500 });
    }

    return NextResponse.json({ ok: true, deduped: result.deduped }, { status: 200 });
  } catch (error) {
    console.error("[growth-ingest] unexpected error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unexpected error" },
      { status: 500 },
    );
  }
}
