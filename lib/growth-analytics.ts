export type GrowthEventOrigin = "web" | "os" | "system";

type AttributionField =
  | "first_source"
  | "first_medium"
  | "first_campaign"
  | "first_campaign_id"
  | "first_content"
  | "first_term"
  | "first_referrer"
  | "landing_path"
  | "current_source"
  | "current_medium"
  | "current_campaign"
  | "current_campaign_id"
  | "current_content"
  | "current_term"
  | "current_referrer"
  | "service_type"
  | "city";

export type AttributableGrowthEvent = {
  event_name: string;
  session_id: string;
  occurred_at: string;
} & Partial<Record<AttributionField, string | null>>;

export type FunnelGrowthEvent = {
  event_name: string;
  session_id: string;
  booking_step?: string | null;
  step_number?: number | null;
};

export type FunnelStageRow = {
  key: string;
  label: string;
  eventName: string;
  stepNumber: number | null;
  sessions: number;
};

const FIRST_TOUCH_FIELDS = [
  "first_source",
  "first_medium",
  "first_campaign",
  "first_campaign_id",
  "first_content",
  "first_term",
  "first_referrer",
  "landing_path",
] as const satisfies readonly AttributionField[];

const CURRENT_TOUCH_FIELDS = [
  "current_source",
  "current_medium",
  "current_campaign",
  "current_campaign_id",
  "current_content",
  "current_term",
  "current_referrer",
  "service_type",
  "city",
] as const satisfies readonly AttributionField[];

/**
 * `server` is the marketing site's legacy name for a server-to-server event.
 * The database constraint uses `system`, so translate it explicitly instead
 * of allowing it to fall through to the browser default (`web`).
 */
export function normalizeGrowthEventOrigin(value: unknown): GrowthEventOrigin {
  if (value === "server") return "system";
  if (value === "web" || value === "os" || value === "system") return value;
  return "web";
}

/**
 * Server-side confirmations do not always repeat the browser's UTM fields.
 * Resolve only missing confirmation fields from events that happened earlier
 * in the same session: first-touch fields keep the first known value, while
 * current-touch and context fields keep the latest known value.
 *
 * The returned array preserves the caller's original order.
 */
export function inheritBookingConfirmationAttribution<T extends AttributableGrowthEvent>(events: readonly T[]): T[] {
  const sessions = new Map<string, { event: T; index: number }[]>();
  events.forEach((event, index) => {
    const rows = sessions.get(event.session_id) || [];
    rows.push({ event, index });
    sessions.set(event.session_id, rows);
  });

  const resolvedByIndex = new Map<number, T>();
  for (const rows of sessions.values()) {
    rows.sort((a, b) => {
      const timeDelta = new Date(a.event.occurred_at).getTime() - new Date(b.event.occurred_at).getTime();
      if (timeDelta !== 0) return timeDelta;
      if (a.event.event_name === b.event.event_name) return a.index - b.index;
      if (a.event.event_name === "booking_confirmed") return 1;
      if (b.event.event_name === "booking_confirmed") return -1;
      return a.index - b.index;
    });

    const firstKnown: Partial<Record<AttributionField, string>> = {};
    const latestKnown: Partial<Record<AttributionField, string>> = {};

    for (const { event, index } of rows) {
      const resolved = { ...event } as T;
      const mutable = resolved as T & Partial<Record<AttributionField, string | null>>;

      if (event.event_name === "booking_confirmed") {
        for (const field of FIRST_TOUCH_FIELDS) {
          if (!mutable[field] && firstKnown[field]) mutable[field] = firstKnown[field];
        }
        for (const field of CURRENT_TOUCH_FIELDS) {
          if (!mutable[field] && latestKnown[field]) mutable[field] = latestKnown[field];
        }
      }

      for (const field of FIRST_TOUCH_FIELDS) {
        const value = mutable[field];
        if (!firstKnown[field] && value) firstKnown[field] = value;
      }
      for (const field of CURRENT_TOUCH_FIELDS) {
        const value = mutable[field];
        if (value) latestKnown[field] = value;
      }

      resolvedByIndex.set(index, resolved);
    }
  }

  return events.map((event, index) => resolvedByIndex.get(index) || event);
}

function isObviousTestSource(value: string | null | undefined): boolean {
  if (!value) return false;
  const source = value.trim().toLowerCase();
  const isVercel = source === "vercel.com" || source.endsWith(".vercel.com") || source.includes("vercel.com/");
  const isTagAssistant = source === "tagassistant.google.com"
    || source === "www.tagassistant.google.com"
    || source.endsWith(".tagassistant.google.com")
    || source.includes("tagassistant.google.com/");
  return source === "qa" || isVercel || isTagAssistant;
}

/** Excludes the whole session once any event identifies it as QA/debug traffic. */
export function filterPrimaryAnalyticsEvents<T extends AttributableGrowthEvent>(events: readonly T[]): T[] {
  const testSessions = new Set(
    events
      .filter((event) => isObviousTestSource(event.first_source) || isObviousTestSource(event.current_source))
      .map((event) => event.session_id),
  );
  return events.filter((event) => !testSessions.has(event.session_id));
}

export function preparePrimaryAnalyticsEvents<T extends AttributableGrowthEvent>(events: readonly T[]): T[] {
  return filterPrimaryAnalyticsEvents(inheritBookingConfirmationAttribution(events));
}

const FIXED_FUNNEL_PREFIX = [
  ["page_view", "כניסות לאתר"],
  ["service_view", "צפייה בשירות"],
  ["price_view", "צפייה במחיר"],
  ["booking_started", "התחלת הזמנה"],
] as const;

const FIXED_FUNNEL_SUFFIX = [
  ["booking_submitted", "הזמנה נשלחה"],
  ["booking_confirmed", "הזמנה אושרה"],
] as const;

function distinctSessions(events: readonly FunnelGrowthEvent[], eventName: string): number {
  return new Set(events.filter((event) => event.event_name === eventName).map((event) => event.session_id)).size;
}

/**
 * A booking_step_completed row means that numbered step was completed. It is
 * therefore shown after booking_started and before submission, one row per
 * completed step, with sessions deduplicated independently at every step.
 */
export function buildFunnelStageRows(events: readonly FunnelGrowthEvent[]): FunnelStageRow[] {
  const prefix: FunnelStageRow[] = FIXED_FUNNEL_PREFIX.map(([eventName, label]) => ({
    key: eventName,
    label,
    eventName,
    stepNumber: null,
    sessions: distinctSessions(events, eventName),
  }));

  const steps = new Map<number, { sessions: Set<string>; names: Map<string, number> }>();
  for (const event of events) {
    if (event.event_name !== "booking_step_completed" || !Number.isInteger(event.step_number) || Number(event.step_number) < 1) continue;
    const stepNumber = Number(event.step_number);
    const group = steps.get(stepNumber) || { sessions: new Set<string>(), names: new Map<string, number>() };
    group.sessions.add(event.session_id);
    const name = event.booking_step?.trim();
    if (name) group.names.set(name, (group.names.get(name) || 0) + 1);
    steps.set(stepNumber, group);
  }

  const stepRows: FunnelStageRow[] = Array.from(steps.entries())
    .sort(([a], [b]) => a - b)
    .map(([stepNumber, group]) => {
      const stepName = Array.from(group.names.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
      return {
        key: `booking_step_completed:${stepNumber}`,
        label: stepName ? `שלב ${stepNumber} הושלם — ${stepName}` : `שלב ${stepNumber} הושלם`,
        eventName: "booking_step_completed",
        stepNumber,
        sessions: group.sessions.size,
      };
    });

  const suffix: FunnelStageRow[] = FIXED_FUNNEL_SUFFIX.map(([eventName, label]) => ({
    key: eventName,
    label,
    eventName,
    stepNumber: null,
    sessions: distinctSessions(events, eventName),
  }));

  return [...prefix, ...stepRows, ...suffix];
}
