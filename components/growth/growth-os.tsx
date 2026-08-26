"use client";

// Factory Growth OS — V1
//
// Self-contained module, deliberately NOT sharing Modal/StatCard/Empty with
// components/factory-clean-os.tsx (same "independent copies per surface"
// convention already used across growth-tracker.js / lib/growthTrack.js /
// api/track.js on the website — see those files' own comments). This keeps
// the change to factory-clean-os.tsx itself down to four lines (Tab type,
// one navItems entry, one import, one render branch) with zero risk to the
// existing jobs/customers/employees/payments code paths.
//
// Data access: exactly like every other view in Factory OS (Customers,
// Jobs, Employees) — plain browser Supabase client calls, protected by RLS
// (public.is_admin() on every growth_* table, see migration-003-growth.sql).
// No new API route is used for reads or for admin-entered data (actions,
// experiments, campaign CSV import, manual booking links) — only
// growth_events itself is API-route-only (service-role write, see
// app/api/growth-ingest/route.ts), because that is the one table real
// visitors' browsers indirectly feed via the website, not the admin.
//
// "Do not create a dashboard museum" (master build doc, Purpose section):
// every screen here either shows a real number computed from real rows, or
// an honest empty state explaining what's missing — nothing here is demo
// data.

import { useCallback, useEffect, useMemo, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// Types — column-exact to migration-003-growth.sql.
// ---------------------------------------------------------------------------

type EventName =
  | "page_view" | "service_view" | "price_view" | "before_after_interaction"
  | "whatsapp_click" | "phone_click" | "booking_started" | "booking_step_completed"
  | "booking_submitted" | "booking_confirmed";

type GrowthEvent = {
  id: string;
  client_event_id: string;
  event_name: EventName;
  event_origin: "web" | "server";
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
  current_source: string | null;
  current_medium: string | null;
  current_campaign: string | null;
  current_campaign_id: string | null;
  value: number | null;
  currency: string;
  occurred_at: string;
};

type BookingJobLink = {
  id: string;
  booking_ref: string;
  website_order_id: string | null;
  factory_customer_id: string | null;
  factory_job_id: string | null;
  link_method: "automatic" | "phone_match" | "manual" | "imported";
  status: "unlinked" | "linked" | "ambiguous" | "rejected";
  confidence: number | null;
  created_at: string;
};

type GrowthJob = {
  id: string;
  job_date: string;
  service_type: string;
  city: string | null;
  status: string;
  gross_amount: number;
  vat_amount: number;
  employee_pay: number;
  direct_expenses: number;
  factory_net: number;
  customer_id: string | null;
  created_at: string;
};

type Campaign = {
  id: string;
  platform: string;
  campaign_external_id: string | null;
  name: string;
  status: "active" | "paused" | "ended";
  service_type: string | null;
  city: string | null;
  created_at: string;
};

type CampaignMetric = {
  id: number;
  campaign_id: string;
  metric_date: string;
  spend: number;
  impressions: number;
  clicks: number;
};

type Experiment = {
  id: string;
  name: string;
  hypothesis: string | null;
  area: string | null;
  control: string | null;
  variant: string | null;
  primary_metric: string | null;
  guardrail: string | null;
  start_date: string | null;
  end_date: string | null;
  status: "draft" | "running" | "won" | "lost" | "inconclusive" | "archived";
  result: string | null;
  decision: string | null;
  created_at: string;
};

type ActionItem = {
  id: string;
  title: string;
  insight_id: string | null;
  type: "do_now" | "test" | "watch" | "ignore";
  priority: number;
  status: "open" | "in_progress" | "done" | "dismissed";
  due_date: string | null;
  expected_impact: string | null;
  metric: string | null;
  notes: string | null;
  outcome: string | null;
  created_at: string;
};

type Insight = {
  id: string;
  type: string;
  finding: string;
  evidence: Record<string, unknown>;
  likely_explanation: string | null;
  confidence: number | null;
  business_impact: string | null;
  recommended_action: string | null;
  measurement_plan: string | null;
  dismissed: boolean;
  created_at: string;
};

type GrowthSubTab =
  | "command_center" | "funnel" | "sources" | "data_health"
  | "actions" | "experiments" | "campaigns" | "profitability" | "ai_insights";

type PeriodKey = "today" | "yesterday" | "7d" | "30d" | "this_month" | "prev_month" | "custom";

// ---------------------------------------------------------------------------
// Formatters — independent copies, matching factory-clean-os.tsx exactly
// (same he-IL/ILS convention, same reasoning as the module header above).
// ---------------------------------------------------------------------------

const money = new Intl.NumberFormat("he-IL", { style: "currency", currency: "ILS", maximumFractionDigits: 2 });
const number = new Intl.NumberFormat("he-IL");
const pct = (value: number) => `${(value * 100).toLocaleString("he-IL", { maximumFractionDigits: 1 })}%`;
const safeDiv = (a: number, b: number) => (b > 0 ? a / b : 0);

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("he-IL", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

// ---------------------------------------------------------------------------
// Small shared UI primitives (independent copies — see header comment).
// ---------------------------------------------------------------------------

function GEmpty({ children }: { children: React.ReactNode }) {
  return <div className="empty-state">{children}</div>;
}

function GStat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <article className="stat-card">
      <span>{label}</span>
      <strong>{value}</strong>
      {note ? <small>{note}</small> : null}
    </article>
  );
}

function GModal({ title, eyebrow, children, onClose, wide = false }: {
  title: string; eyebrow?: string; children: React.ReactNode; onClose: () => void; wide?: boolean;
}) {
  useEffect(() => {
    const handler = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className={`modal-card ${wide ? "modal-wide" : ""}`} role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <div>{eyebrow ? <span className="eyebrow">{eyebrow}</span> : null}<h2>{title}</h2></div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="סגירה">×</button>
        </header>
        {children}
      </section>
    </div>
  );
}

function Pill({ tone, children }: { tone: "green" | "yellow" | "red" | "neutral"; children: React.ReactNode }) {
  const toneClass = tone === "green" ? "approved" : tone === "yellow" ? "pending" : tone === "red" ? "rejected" : "completed";
  return <span className={`status ${toneClass}`}>{children}</span>;
}

// ---------------------------------------------------------------------------
// Period range helper (master build doc section 2's exact period list).
// ---------------------------------------------------------------------------

function periodRange(period: PeriodKey, customFrom: string, customTo: string): { from: Date; to: Date; label: string } {
  const now = new Date();
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const endOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
  const today0 = startOfDay(now);

  switch (period) {
    case "today": return { from: today0, to: endOfDay(now), label: "היום" };
    case "yesterday": {
      const y = new Date(today0); y.setDate(y.getDate() - 1);
      return { from: y, to: endOfDay(y), label: "אתמול" };
    }
    case "7d": {
      const from = new Date(today0); from.setDate(from.getDate() - 6);
      return { from, to: endOfDay(now), label: "7 ימים אחרונים" };
    }
    case "30d": {
      const from = new Date(today0); from.setDate(from.getDate() - 29);
      return { from, to: endOfDay(now), label: "30 ימים אחרונים" };
    }
    case "this_month": {
      const from = new Date(now.getFullYear(), now.getMonth(), 1);
      return { from, to: endOfDay(now), label: "החודש" };
    }
    case "prev_month": {
      const from = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const to = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
      return { from, to, label: "חודש קודם" };
    }
    case "custom": {
      const from = customFrom ? new Date(`${customFrom}T00:00:00`) : today0;
      const to = customTo ? new Date(`${customTo}T23:59:59`) : endOfDay(now);
      return { from, to, label: "טווח מותאם" };
    }
  }
}

// previous equivalent-length period, immediately before `from` — used only
// for the Command Center's "what changed" comparison.
function previousEquivalent(from: Date, to: Date) {
  const spanMs = to.getTime() - from.getTime();
  const prevTo = new Date(from.getTime() - 1);
  const prevFrom = new Date(prevTo.getTime() - spanMs);
  return { from: prevFrom, to: prevTo };
}

// ---------------------------------------------------------------------------
// Main shell
// ---------------------------------------------------------------------------

export default function GrowthOS({ supabase, isAdmin }: { supabase: SupabaseClient; isAdmin: boolean }) {
  const [subTab, setSubTab] = useState<GrowthSubTab>("command_center");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const [events, setEvents] = useState<GrowthEvent[]>([]);
  const [links, setLinks] = useState<BookingJobLink[]>([]);
  const [jobs, setJobs] = useState<GrowthJob[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [campaignMetrics, setCampaignMetrics] = useState<CampaignMetric[]>([]);
  const [experiments, setExperiments] = useState<Experiment[]>([]);
  const [actions, setActions] = useState<ActionItem[]>([]);
  const [insights, setInsights] = useState<Insight[]>([]);

  const [period, setPeriod] = useState<PeriodKey>("30d");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");

  // Single bounded fetch, filtered client-side per period — same pattern
  // Dashboard already uses for `jobs` (periodJobs useMemo in
  // factory-clean-os.tsx). growth_events is brand new (zero historical
  // rows as of this build) so a 20k-row cap is nowhere close to being hit;
  // flagged here for whoever revisits this once volume grows (Phase 2:
  // move filtering server-side / paginate).
  const loadAll = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    const [eventsRes, linksRes, jobsRes, campaignsRes, metricsRes, experimentsRes, actionsRes, insightsRes] = await Promise.all([
      supabase.from("growth_events").select(
        "id, client_event_id, event_name, event_origin, session_id, anonymous_id, page_path, service_type, booking_step, step_number, cta_location, device_type, city, booking_ref, first_source, first_medium, first_campaign, first_campaign_id, current_source, current_medium, current_campaign, current_campaign_id, value, currency, occurred_at"
      ).order("occurred_at", { ascending: false }).limit(20000),
      supabase.from("growth_booking_job_links").select("id, booking_ref, website_order_id, factory_customer_id, factory_job_id, link_method, status, confidence, created_at").limit(5000),
      supabase.from("jobs").select("id, job_date, service_type, city, status, gross_amount, vat_amount, employee_pay, direct_expenses, factory_net, customer_id, created_at")
        .in("status", ["approved", "completed"]).order("job_date", { ascending: false }).limit(3000),
      supabase.from("growth_campaigns").select("id, platform, campaign_external_id, name, status, service_type, city, created_at").order("name"),
      supabase.from("growth_campaign_daily_metrics").select("id, campaign_id, metric_date, spend, impressions, clicks").limit(10000),
      supabase.from("growth_experiments").select("*").order("created_at", { ascending: false }),
      supabase.from("growth_actions").select("*").order("created_at", { ascending: false }),
      supabase.from("growth_ai_insights").select("*").eq("dismissed", false).order("created_at", { ascending: false }).limit(50),
    ]);

    const firstError = [eventsRes.error, linksRes.error, jobsRes.error, campaignsRes.error, metricsRes.error, experimentsRes.error, actionsRes.error, insightsRes.error].find(Boolean);
    if (firstError) setLoadError(firstError.message);

    setEvents((eventsRes.data || []) as GrowthEvent[]);
    setLinks((linksRes.data || []) as BookingJobLink[]);
    setJobs((jobsRes.data || []).map((j: any) => ({
      ...j,
      gross_amount: Number(j.gross_amount) || 0,
      vat_amount: Number(j.vat_amount) || 0,
      employee_pay: Number(j.employee_pay) || 0,
      direct_expenses: Number(j.direct_expenses) || 0,
      factory_net: Number(j.factory_net) || 0,
    })) as GrowthJob[]);
    setCampaigns((campaignsRes.data || []) as Campaign[]);
    setCampaignMetrics((metricsRes.data || []).map((m: any) => ({ ...m, spend: Number(m.spend) || 0, impressions: Number(m.impressions) || 0, clicks: Number(m.clicks) || 0 })) as CampaignMetric[]);
    setExperiments((experimentsRes.data || []) as Experiment[]);
    setActions((actionsRes.data || []) as ActionItem[]);
    setInsights((insightsRes.data || []) as Insight[]);
    setLoading(false);
  }, [supabase]);

  useEffect(() => { if (isAdmin) void loadAll(); }, [isAdmin, loadAll]);

  const range = useMemo(() => periodRange(period, customFrom, customTo), [period, customFrom, customTo]);
  const periodEvents = useMemo(
    () => events.filter((e) => { const t = new Date(e.occurred_at); return t >= range.from && t <= range.to; }),
    [events, range],
  );
  const linkByRef = useMemo(() => {
    const map = new Map<string, BookingJobLink>();
    for (const l of links) map.set(l.booking_ref, l);
    return map;
  }, [links]);
  const jobById = useMemo(() => {
    const map = new Map<string, GrowthJob>();
    for (const j of jobs) map.set(j.id, j);
    return map;
  }, [jobs]);

  if (!isAdmin) {
    return (
      <div className="page-content">
        <GEmpty>מסך זה זמין למנהל בלבד.</GEmpty>
      </div>
    );
  }

  const SUB_NAV: { id: GrowthSubTab; label: string }[] = [
    { id: "command_center", label: "מרכז שליטה" },
    { id: "funnel", label: "משפך" },
    { id: "sources", label: "מקורות" },
    { id: "data_health", label: "בריאות נתונים" },
    { id: "actions", label: "פעולות" },
    { id: "experiments", label: "ניסויים" },
    { id: "campaigns", label: "קמפיינים" },
    { id: "profitability", label: "רווחיות" },
    { id: "ai_insights", label: "תובנות AI" },
  ];

  return (
    <div className="page-content">
      <nav className="growth-subnav" role="tablist">
        {SUB_NAV.map((item) => (
          <button key={item.id} className={subTab === item.id ? "active" : ""} onClick={() => setSubTab(item.id)} role="tab" aria-selected={subTab === item.id}>
            {item.label}
          </button>
        ))}
      </nav>

      {loadError ? <p className="form-error">שגיאה בטעינת נתוני Growth: {loadError}</p> : null}
      {loading ? <GEmpty>טוען נתוני Growth…</GEmpty> : (
        <>
          {subTab === "command_center" ? (
            <CommandCenterView
              periodEvents={periodEvents} allEvents={events} range={range} period={period} setPeriod={setPeriod}
              customFrom={customFrom} customTo={customTo} setCustomFrom={setCustomFrom} setCustomTo={setCustomTo}
              linkByRef={linkByRef} jobById={jobById} campaignMetrics={campaignMetrics} actions={actions}
            />
          ) : null}
          {subTab === "funnel" ? <FunnelView periodEvents={periodEvents} allEvents={events} linkByRef={linkByRef} jobById={jobById} /> : null}
          {subTab === "sources" ? <SourcesView periodEvents={periodEvents} linkByRef={linkByRef} jobById={jobById} /> : null}
          {subTab === "data_health" ? <DataHealthView events={events} links={links} /> : null}
          {subTab === "actions" ? <ActionsView supabase={supabase} actions={actions} insights={insights} reload={loadAll} /> : null}
          {subTab === "experiments" ? <ExperimentsView supabase={supabase} experiments={experiments} reload={loadAll} /> : null}
          {subTab === "campaigns" ? <CampaignsView supabase={supabase} campaigns={campaigns} campaignMetrics={campaignMetrics} events={events} linkByRef={linkByRef} jobById={jobById} reload={loadAll} /> : null}
          {subTab === "profitability" ? <ProfitabilityView supabase={supabase} jobs={jobs} links={links} events={events} reload={loadAll} /> : null}
          {subTab === "ai_insights" ? <AIInsightsView supabase={supabase} insights={insights} events={events} links={links} jobById={jobById} reload={loadAll} /> : null}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Command Center (section 2)
// ---------------------------------------------------------------------------

function CommandCenterView({ periodEvents, allEvents, range, period, setPeriod, customFrom, customTo, setCustomFrom, setCustomTo, linkByRef, jobById, campaignMetrics, actions }: {
  periodEvents: GrowthEvent[]; allEvents: GrowthEvent[]; range: { from: Date; to: Date; label: string };
  period: PeriodKey; setPeriod: (p: PeriodKey) => void;
  customFrom: string; customTo: string; setCustomFrom: (v: string) => void; setCustomTo: (v: string) => void;
  linkByRef: Map<string, BookingJobLink>; jobById: Map<string, GrowthJob>;
  campaignMetrics: CampaignMetric[]; actions: ActionItem[];
}) {
  const stats = useMemo(() => computePeriodStats(periodEvents, linkByRef, jobById, campaignMetrics, range), [periodEvents, linkByRef, jobById, campaignMetrics, range]);
  const prevRange = useMemo(() => previousEquivalent(range.from, range.to), [range]);
  const prevEvents = useMemo(() => allEvents.filter((e) => { const t = new Date(e.occurred_at); return t >= prevRange.from && t <= prevRange.to; }), [allEvents, prevRange]);
  const prevStats = useMemo(() => computePeriodStats(prevEvents, linkByRef, jobById, campaignMetrics, prevRange), [prevEvents, linkByRef, jobById, campaignMetrics, prevRange]);

  const bySourceRows = useMemo(() => groupBySource(periodEvents, linkByRef, jobById), [periodEvents, linkByRef, jobById]);
  const byServiceRows = useMemo(() => groupByService(periodEvents, linkByRef, jobById), [periodEvents, linkByRef, jobById]);
  const bestSource = bySourceRows.filter((r) => r.confirmed > 0).sort((a, b) => b.factoryNet - a.factoryNet)[0];
  const worstSource = bySourceRows.filter((r) => r.sessions >= 10).sort((a, b) => a.conversion - b.conversion)[0];
  const bestService = byServiceRows.sort((a, b) => b.factoryNet - a.factoryNet)[0];
  const topActions = actions.filter((a) => a.status === "open").sort((a, b) => a.priority - b.priority).slice(0, 5);

  const delta = (curr: number, prev: number) => (prev === 0 ? null : (curr - prev) / prev);
  const deltaLabel = (curr: number, prev: number) => {
    const d = delta(curr, prev);
    if (d === null) return null;
    const sign = d >= 0 ? "+" : "";
    return `${sign}${pct(d)} לעומת התקופה הקודמת`;
  };

  return (
    <div className="page-content" style={{ padding: 0 }}>
      <section className="hero-panel">
        <div>
          <span className="eyebrow">Factory Growth OS</span>
          <h2>מאיפה מגיע כסף, ולאן ללכת הלאה.</h2>
          <p>{range.label}: {formatDateTime(range.from.toISOString())} — {formatDateTime(range.to.toISOString())}</p>
        </div>
        <div className="period-switch">
          {([
            ["today", "היום"], ["yesterday", "אתמול"], ["7d", "7 ימים"], ["30d", "30 ימים"],
            ["this_month", "החודש"], ["prev_month", "חודש קודם"], ["custom", "טווח"],
          ] as [PeriodKey, string][]).map(([key, label]) => (
            <button key={key} className={period === key ? "active" : ""} onClick={() => setPeriod(key)}>{label}</button>
          ))}
        </div>
      </section>

      {period === "custom" ? (
        <section className="toolbar-card">
          <label><span>מתאריך</span><input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} /></label>
          <label><span>עד תאריך</span><input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} /></label>
        </section>
      ) : null}

      <section className="stats-grid three">
        <GStat label="כניסות (sessions)" value={number.format(stats.sessions)} note={deltaLabel(stats.sessions, prevStats.sessions) || undefined} />
        <GStat label="התחלות הזמנה" value={number.format(stats.bookingStarts)} />
        <GStat label="הזמנות שנשלחו" value={number.format(stats.bookingSubmitted)} />
        <GStat label="הזמנות מאושרות" value={number.format(stats.confirmed)} note={deltaLabel(stats.confirmed, prevStats.confirmed) || undefined} />
        <GStat label="שיעור המרה" value={pct(stats.conversion)} note="מכניסה להזמנה מאושרת" />
        <GStat label="שווי הזמנה ממוצע" value={money.format(stats.avgBookingValue)} />
        <GStat label="הכנסות לפני מע״מ (מקושר)" value={money.format(stats.revenue)} note={deltaLabel(stats.revenue, prevStats.revenue) || undefined} />
        <GStat label="נטו לפקטורי (מקושר)" value={money.format(stats.factoryNet)} />
        <GStat label="הוצאת שיווק" value={money.format(stats.spend)} note={stats.spend === 0 ? "אין עדיין ייבוא הוצאות" : undefined} />
        <GStat label="ROAS / MER" value={stats.spend > 0 ? safeDiv(stats.revenue, stats.spend).toFixed(2) : "—"} />
        <GStat label="עלות להזמנה מאושרת (CAC)" value={stats.confirmed > 0 && stats.spend > 0 ? money.format(stats.spend / stats.confirmed) : "—"} />
        <GStat label="תרומה אחרי שיווק" value={money.format(stats.factoryNet - stats.spend)} />
      </section>

      <div className="dashboard-grid">
        <section className="section-card">
          <div className="section-title"><div><span className="eyebrow">מה השתנה</span><h2>לעומת התקופה המקבילה הקודמת</h2></div></div>
          {prevStats.sessions === 0 && prevStats.confirmed === 0 ? (
            <GEmpty>אין עדיין תקופה קודמת להשוואה.</GEmpty>
          ) : (
            <div className="employee-summary-list">
              <article><div><strong>כניסות</strong></div><div><strong>{number.format(stats.sessions)}</strong><span>{deltaLabel(stats.sessions, prevStats.sessions) || "—"}</span></div></article>
              <article><div><strong>הזמנות מאושרות</strong></div><div><strong>{number.format(stats.confirmed)}</strong><span>{deltaLabel(stats.confirmed, prevStats.confirmed) || "—"}</span></div></article>
              <article><div><strong>הכנסות (מקושר)</strong></div><div><strong>{money.format(stats.revenue)}</strong><span>{deltaLabel(stats.revenue, prevStats.revenue) || "—"}</span></div></article>
            </div>
          )}
        </section>
        <section className="section-card">
          <div className="section-title"><div><span className="eyebrow">היום</span><h2>עדיפות עליונה</h2></div></div>
          {topActions.length ? (
            <div className="employee-summary-list">
              {topActions.map((a) => (
                <article key={a.id}><div><strong>{a.title}</strong><span>{ACTION_TYPE_LABELS[a.type]}</span></div><div><Pill tone={a.type === "do_now" ? "red" : a.type === "test" ? "yellow" : "neutral"}>עדיפות {a.priority}</Pill></div></article>
              ))}
            </div>
          ) : <GEmpty>אין פעולות פתוחות כרגע. עברו למסך "תובנות AI" כדי לייצר המלצות.</GEmpty>}
        </section>
      </div>

      <div className="dashboard-grid">
        <section className="section-card">
          <div className="section-title"><div><span className="eyebrow">מקור</span><h2>הכי טוב / הכי חלש</h2></div></div>
          {bySourceRows.length ? (
            <div className="employee-summary-list">
              {bestSource ? <article><div><strong>הכי רווחי</strong><span>{bestSource.source}</span></div><div><strong>{money.format(bestSource.factoryNet)}</strong><span>נטו לפקטורי</span></div></article> : null}
              {worstSource ? <article><div><strong>שיעור המרה נמוך</strong><span>{worstSource.source}</span></div><div><strong>{pct(worstSource.conversion)}</strong><span>{number.format(worstSource.sessions)} כניסות</span></div></article> : null}
            </div>
          ) : <GEmpty>אין עדיין מספיק נתונים לדרג מקורות.</GEmpty>}
        </section>
        <section className="section-card">
          <div className="section-title"><div><span className="eyebrow">שירות</span><h2>הכי רווחי</h2></div></div>
          {bestService ? (
            <div className="employee-summary-list">
              <article><div><strong>{bestService.service}</strong><span>{number.format(bestService.confirmed)} הזמנות מקושרות</span></div><div><strong>{money.format(bestService.factoryNet)}</strong><span>נטו לפקטורי</span></div></article>
            </div>
          ) : <GEmpty>אין עדיין עבודות מקושרות לפי שירות בתקופה הזו.</GEmpty>}
        </section>
      </div>
    </div>
  );
}

const ACTION_TYPE_LABELS: Record<ActionItem["type"], string> = { do_now: "לביצוע מיידי", test: "לבדיקה", watch: "למעקב", ignore: "להתעלמות" };

function computePeriodStats(periodEvents: GrowthEvent[], linkByRef: Map<string, BookingJobLink>, jobById: Map<string, GrowthJob>, campaignMetrics: CampaignMetric[], range: { from: Date; to: Date }) {
  const sessions = new Set(periodEvents.map((e) => e.session_id)).size;
  const bookingStarts = periodEvents.filter((e) => e.event_name === "booking_started").length;
  const bookingSubmitted = periodEvents.filter((e) => e.event_name === "booking_submitted").length;
  const confirmedRefs = new Set(periodEvents.filter((e) => e.event_name === "booking_confirmed" && e.booking_ref).map((e) => e.booking_ref as string));
  const confirmed = confirmedRefs.size;

  let revenue = 0, vat = 0, employeePay = 0, directExpenses = 0, factoryNet = 0, linkedCount = 0;
  for (const ref of confirmedRefs) {
    const link = linkByRef.get(ref);
    const job = link?.factory_job_id ? jobById.get(link.factory_job_id) : undefined;
    if (job) {
      linkedCount += 1;
      revenue += job.gross_amount; vat += job.vat_amount; employeePay += job.employee_pay;
      directExpenses += job.direct_expenses; factoryNet += job.factory_net;
    }
  }

  const spend = campaignMetrics
    .filter((m) => { const d = new Date(`${m.metric_date}T12:00:00`); return d >= range.from && d <= range.to; })
    .reduce((sum, m) => sum + m.spend, 0);

  return {
    sessions, bookingStarts, bookingSubmitted, confirmed, linkedCount,
    conversion: safeDiv(confirmed, sessions),
    avgBookingValue: safeDiv(revenue, linkedCount),
    revenue, vat, employeePay, directExpenses, factoryNet, spend,
  };
}

function groupBySource(periodEvents: GrowthEvent[], linkByRef: Map<string, BookingJobLink>, jobById: Map<string, GrowthJob>) {
  const bySession = new Map<string, string>(); // session_id -> current_source at first event seen
  for (const e of periodEvents) if (!bySession.has(e.session_id)) bySession.set(e.session_id, e.current_source || "לא ידוע");

  const sessionsBySource = new Map<string, number>();
  for (const source of bySession.values()) sessionsBySource.set(source, (sessionsBySource.get(source) || 0) + 1);

  const confirmedBySource = new Map<string, Set<string>>();
  for (const e of periodEvents) {
    if (e.event_name !== "booking_confirmed" || !e.booking_ref) continue;
    const source = e.current_source || "לא ידוע";
    if (!confirmedBySource.has(source)) confirmedBySource.set(source, new Set());
    confirmedBySource.get(source)!.add(e.booking_ref);
  }

  const rows: { source: string; sessions: number; confirmed: number; conversion: number; factoryNet: number }[] = [];
  const allSources = new Set([...sessionsBySource.keys(), ...confirmedBySource.keys()]);
  for (const source of allSources) {
    const sessions = sessionsBySource.get(source) || 0;
    const refs = confirmedBySource.get(source) || new Set<string>();
    let factoryNet = 0;
    for (const ref of refs) {
      const link = linkByRef.get(ref);
      const job = link?.factory_job_id ? jobById.get(link.factory_job_id) : undefined;
      if (job) factoryNet += job.factory_net;
    }
    rows.push({ source, sessions, confirmed: refs.size, conversion: safeDiv(refs.size, sessions), factoryNet });
  }
  return rows.sort((a, b) => b.sessions - a.sessions);
}

function groupByService(periodEvents: GrowthEvent[], linkByRef: Map<string, BookingJobLink>, jobById: Map<string, GrowthJob>) {
  const confirmedByService = new Map<string, Set<string>>();
  for (const e of periodEvents) {
    if (e.event_name !== "booking_confirmed" || !e.booking_ref) continue;
    const service = e.service_type || "לא צוין";
    if (!confirmedByService.has(service)) confirmedByService.set(service, new Set());
    confirmedByService.get(service)!.add(e.booking_ref);
  }
  const rows: { service: string; confirmed: number; factoryNet: number }[] = [];
  for (const [service, refs] of confirmedByService) {
    let factoryNet = 0;
    for (const ref of refs) {
      const link = linkByRef.get(ref);
      const job = link?.factory_job_id ? jobById.get(link.factory_job_id) : undefined;
      if (job) factoryNet += job.factory_net;
    }
    rows.push({ service, confirmed: refs.size, factoryNet });
  }
  return rows.sort((a, b) => b.factoryNet - a.factoryNet);
}

// ---------------------------------------------------------------------------
// Funnel (section 3)
// ---------------------------------------------------------------------------

const FUNNEL_STAGES: { name: EventName; label: string }[] = [
  { name: "page_view", label: "כניסות לאתר" },
  { name: "service_view", label: "צפייה בשירות" },
  { name: "price_view", label: "צפייה במחיר" },
  { name: "booking_started", label: "התחלת הזמנה" },
  { name: "booking_step_completed", label: "התקדמות בהזמנה" },
  { name: "booking_submitted", label: "הזמנה נשלחה" },
  { name: "booking_confirmed", label: "הזמנה אושרה" },
];

function FunnelView({ periodEvents, allEvents, linkByRef, jobById }: {
  periodEvents: GrowthEvent[]; allEvents: GrowthEvent[]; linkByRef: Map<string, BookingJobLink>; jobById: Map<string, GrowthJob>;
}) {
  const [lookupRef, setLookupRef] = useState("");

  const stageCounts = useMemo(() => {
    return FUNNEL_STAGES.map((stage) => {
      const rows = periodEvents.filter((e) => e.event_name === stage.name);
      const uniqueSessions = new Set(rows.map((e) => e.session_id)).size;
      return { ...stage, sessions: uniqueSessions };
    });
  }, [periodEvents]);

  const journeyResults = useMemo(() => {
    if (!lookupRef.trim()) return [];
    return allEvents.filter((e) => e.booking_ref === lookupRef.trim()).sort((a, b) => new Date(a.occurred_at).getTime() - new Date(b.occurred_at).getTime());
  }, [allEvents, lookupRef]);

  if (!periodEvents.length) {
    return <GEmpty>אין עדיין נתוני משפך לתקופה הזו. ברגע שיתחילו להגיע אירועים אמיתיים מהאתר, המשפך יתמלא כאן.</GEmpty>;
  }

  return (
    <div className="page-content" style={{ padding: 0 }}>
      <section className="section-card">
        <div className="section-title"><div><span className="eyebrow">המסע</span><h2>מכניסה עד הזמנה מאושרת</h2></div></div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>שלב</th><th>כניסות ייחודיות</th><th>המרה מהשלב הקודם</th><th>נשירה</th></tr></thead>
            <tbody>
              {stageCounts.map((stage, i) => {
                const prev = i > 0 ? stageCounts[i - 1].sessions : stage.sessions;
                const conv = i === 0 ? 1 : safeDiv(stage.sessions, prev);
                return (
                  <tr key={stage.name}>
                    <td>{stage.label}</td>
                    <td className="money-cell">{number.format(stage.sessions)}</td>
                    <td>{i === 0 ? "—" : pct(conv)}</td>
                    <td>{i === 0 ? "—" : pct(1 - conv)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="section-card">
        <div className="section-title"><div><span className="eyebrow">בדיקה נקודתית</span><h2>מסע לפי מספר הזמנה</h2></div></div>
        <div className="toolbar-card">
          <div className="search-field">
            <input placeholder="לדוגמה: FC-20260825-0001" value={lookupRef} onChange={(e) => setLookupRef(e.target.value)} />
          </div>
        </div>
        {lookupRef.trim() ? (
          journeyResults.length ? (
            <div className="table-wrap">
              <table>
                <thead><tr><th>זמן</th><th>אירוע</th><th>מקור</th><th>שירות</th></tr></thead>
                <tbody>
                  {journeyResults.map((e) => (
                    <tr key={e.id}><td className="nowrap">{formatDateTime(e.occurred_at)}</td><td>{EVENT_LABELS[e.event_name]}</td><td>{e.current_source || "—"}</td><td>{e.service_type || "—"}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <GEmpty>לא נמצאו אירועים למספר הזמנה זה.</GEmpty>
        ) : null}
      </section>
    </div>
  );
}

const EVENT_LABELS: Record<EventName, string> = {
  page_view: "צפייה בעמוד", service_view: "צפייה בשירות", price_view: "צפייה במחיר",
  before_after_interaction: "אינטראקציה לפני/אחרי", whatsapp_click: "קליק לוואטסאפ", phone_click: "קליק לטלפון",
  booking_started: "התחלת הזמנה", booking_step_completed: "שלב בהזמנה הושלם", booking_submitted: "הזמנה נשלחה", booking_confirmed: "הזמנה אושרה",
};

// ---------------------------------------------------------------------------
// Sources (section 4)
// ---------------------------------------------------------------------------

function SourcesView({ periodEvents, linkByRef, jobById }: { periodEvents: GrowthEvent[]; linkByRef: Map<string, BookingJobLink>; jobById: Map<string, GrowthJob> }) {
  const [touchModel, setTouchModel] = useState<"current" | "first">("current");
  const rows = useMemo(() => {
    const sessionSource = new Map<string, string>();
    for (const e of periodEvents) {
      const key = touchModel === "current" ? e.current_source : e.first_source;
      if (!sessionSource.has(e.session_id)) sessionSource.set(e.session_id, key || "לא מיוחס");
    }
    const sessionsBySource = new Map<string, number>();
    for (const s of sessionSource.values()) sessionsBySource.set(s, (sessionsBySource.get(s) || 0) + 1);

    const confirmedBySource = new Map<string, Set<string>>();
    for (const e of periodEvents) {
      if (e.event_name !== "booking_confirmed" || !e.booking_ref) continue;
      const key = (touchModel === "current" ? e.current_source : e.first_source) || "לא מיוחס";
      if (!confirmedBySource.has(key)) confirmedBySource.set(key, new Set());
      confirmedBySource.get(key)!.add(e.booking_ref);
    }

    const allSources = new Set([...sessionsBySource.keys(), ...confirmedBySource.keys()]);
    return Array.from(allSources).map((source) => {
      const sessions = sessionsBySource.get(source) || 0;
      const refs = confirmedBySource.get(source) || new Set<string>();
      let revenue = 0;
      for (const ref of refs) {
        const link = linkByRef.get(ref);
        const job = link?.factory_job_id ? jobById.get(link.factory_job_id) : undefined;
        if (job) revenue += job.gross_amount;
      }
      return { source, sessions, confirmed: refs.size, conversion: safeDiv(refs.size, sessions), revenue };
    }).sort((a, b) => b.sessions - a.sessions);
  }, [periodEvents, linkByRef, jobById, touchModel]);

  return (
    <div className="page-content" style={{ padding: 0 }}>
      <section className="toolbar-card">
        <div className="segment-control" role="tablist" style={{ maxWidth: 320 }}>
          <button className={touchModel === "current" ? "active" : ""} onClick={() => setTouchModel("current")}>מגע נוכחי</button>
          <button className={touchModel === "first" ? "active" : ""} onClick={() => setTouchModel("first")}>מגע ראשון</button>
        </div>
      </section>
      <section className="section-card">
        <div className="section-title"><div><span className="eyebrow">מקורות</span><h2>לפי {touchModel === "current" ? "מגע נוכחי" : "מגע ראשון"}</h2></div></div>
        {rows.length ? (
          <div className="table-wrap">
            <table>
              <thead><tr><th>מקור</th><th>כניסות</th><th>הזמנות מאושרות</th><th>המרה</th><th>הכנסה (מקושר, לפני מע״מ)</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.source}>
                    <td>{r.source === "direct" ? "כניסה ישירה" : r.source}</td>
                    <td className="money-cell">{number.format(r.sessions)}</td>
                    <td className="money-cell">{number.format(r.confirmed)}</td>
                    <td>{pct(r.conversion)}</td>
                    <td className="money-cell">{money.format(r.revenue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <GEmpty>אין עדיין נתוני מקורות לתקופה הזו.</GEmpty>}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Data Health (section 13) — every number here is honestly computed from
// stored rows; nothing here is estimated or invented.
// ---------------------------------------------------------------------------

function DataHealthView({ events, links }: { events: GrowthEvent[]; links: BookingJobLink[] }) {
  const now = Date.now();
  const lastEvent = events[0]; // already ordered occurred_at desc
  const last24h = events.filter((e) => now - new Date(e.occurred_at).getTime() < 24 * 60 * 60 * 1000).length;
  const missingBookingRef = events.filter((e) => (e.event_name === "booking_submitted" || e.event_name === "booking_confirmed") && !e.booking_ref).length;
  const bookingRelevant = events.filter((e) => e.event_name === "booking_submitted" || e.event_name === "booking_confirmed").length;
  const unattributed = events.filter((e) => !e.current_source || e.current_source === "direct").length;

  const confirmedRefs = new Set(events.filter((e) => e.event_name === "booking_confirmed" && e.booking_ref).map((e) => e.booking_ref as string));
  const linkedRefs = new Set(links.filter((l) => l.status === "linked").map((l) => l.booking_ref));
  const confirmedLinked = Array.from(confirmedRefs).filter((r) => linkedRefs.has(r)).length;

  const staleMinutes = lastEvent ? Math.round((now - new Date(lastEvent.occurred_at).getTime()) / 60000) : null;

  const checks: { name: string; severity: "red" | "yellow" | "green"; message: string }[] = [
    {
      name: "טריות אירועים",
      severity: staleMinutes === null ? "red" : staleMinutes < 180 ? "green" : staleMinutes < 1440 ? "yellow" : "red",
      message: staleMinutes === null ? "עדיין לא התקבל אף אירוע ב-growth_events." : `האירוע האחרון התקבל לפני ${number.format(staleMinutes)} דקות.`,
    },
    {
      name: "נפח 24 שעות אחרונות",
      severity: last24h > 0 ? "green" : "red",
      message: last24h > 0 ? `${number.format(last24h)} אירועים ב-24 השעות האחרונות.` : "אין אף אירוע ב-24 השעות האחרונות — יש לבדוק שהאתר שולח ושה-endpoint פעיל.",
    },
    {
      name: "מספרי הזמנה חסרים",
      severity: bookingRelevant === 0 ? "yellow" : missingBookingRef / bookingRelevant > 0.05 ? "red" : "green",
      message: bookingRelevant === 0 ? "אין עדיין אירועי הזמנה לבדיקה." : `${pct(safeDiv(missingBookingRef, bookingRelevant))} מאירועי ההזמנה חסר להם booking_ref.`,
    },
    {
      name: "ייחוס לא ידוע",
      severity: events.length === 0 ? "yellow" : unattributed / events.length > 0.6 ? "yellow" : "green",
      message: events.length === 0 ? "אין עדיין נתונים." : `${pct(safeDiv(unattributed, events.length))} מהאירועים ללא מקור ידוע (כניסה ישירה או חסר).`,
    },
    {
      name: "קישור הזמנה→עבודה",
      severity: confirmedRefs.size === 0 ? "yellow" : confirmedLinked / confirmedRefs.size < 0.5 ? "red" : confirmedLinked / confirmedRefs.size < 0.85 ? "yellow" : "green",
      message: confirmedRefs.size === 0 ? "אין עדיין הזמנות מאושרות לקשר." : `${number.format(confirmedLinked)} מתוך ${number.format(confirmedRefs.size)} הזמנות מאושרות מקושרות לעבודה אמיתית (${pct(safeDiv(confirmedLinked, confirmedRefs.size))}).`,
    },
  ];

  return (
    <div className="page-content" style={{ padding: 0 }}>
      <section className="section-card">
        <div className="section-title"><div><span className="eyebrow">בריאות המערכת</span><h2>מה אפשר לסמוך עליו עכשיו</h2></div></div>
        <div className="employee-summary-list">
          {checks.map((c) => (
            <article key={c.name}>
              <div><strong>{c.name}</strong><span>{c.message}</span></div>
              <div><Pill tone={c.severity}>{c.severity === "green" ? "תקין" : c.severity === "yellow" ? "לתשומת לב" : "בעיה"}</Pill></div>
            </article>
          ))}
        </div>
        <p className="helper-text">שיעור כפילויות ושגיאות קליטה בפועל נמדדים בלוגים של Vercel (api/growth-ingest) ולא כאן — טרם קיים מסך שמרכז אותם, ולכן לא מוצג מספר בדוי במקומם.</p>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Actions (section 12)
// ---------------------------------------------------------------------------

function ActionsView({ supabase, actions, insights, reload }: { supabase: SupabaseClient; actions: ActionItem[]; insights: Insight[]; reload: () => Promise<void> }) {
  const [modalOpen, setModalOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function setStatus(id: string, status: ActionItem["status"]) {
    setBusy(true);
    await supabase.from("growth_actions").update({ status }).eq("id", id);
    await reload();
    setBusy(false);
  }

  const open = actions.filter((a) => a.status === "open" || a.status === "in_progress").sort((a, b) => a.priority - b.priority);
  const closed = actions.filter((a) => a.status === "done" || a.status === "dismissed").slice(0, 20);

  return (
    <div className="page-content" style={{ padding: 0 }}>
      <section className="toolbar-card">
        <button className="primary-button" onClick={() => setModalOpen(true)}>+ פעולה חדשה</button>
      </section>
      <section className="section-card">
        <div className="section-title"><div><span className="eyebrow">פתוחות</span><h2>פעולות פעילות</h2></div></div>
        {open.length ? (
          <div className="employee-summary-list">
            {open.map((a) => (
              <article key={a.id}>
                <div><strong>{a.title}</strong><span>{ACTION_TYPE_LABELS[a.type]} · עדיפות {a.priority}{a.due_date ? ` · יעד ${a.due_date}` : ""}</span></div>
                <div className="row-actions">
                  <button className="small-button success" disabled={busy} onClick={() => setStatus(a.id, "done")}>סיום</button>
                  <button className="small-button" disabled={busy} onClick={() => setStatus(a.id, "dismissed")}>ביטול</button>
                </div>
              </article>
            ))}
          </div>
        ) : <GEmpty>אין פעולות פתוחות. מסך "תובנות AI" יכול לייצר המלצות חדשות.</GEmpty>}
      </section>
      {closed.length ? (
        <section className="section-card">
          <div className="section-title"><div><span className="eyebrow">היסטוריה</span><h2>נסגרו לאחרונה</h2></div></div>
          <div className="employee-summary-list">
            {closed.map((a) => (
              <article key={a.id}><div><strong>{a.title}</strong><span>{ACTION_TYPE_LABELS[a.type]}</span></div><div><Pill tone={a.status === "done" ? "green" : "neutral"}>{a.status === "done" ? "הושלם" : "בוטל"}</Pill></div></article>
            ))}
          </div>
        </section>
      ) : null}
      {modalOpen ? <NewActionModal supabase={supabase} insights={insights} onClose={() => setModalOpen(false)} onSaved={async () => { setModalOpen(false); await reload(); }} /> : null}
    </div>
  );
}

function NewActionModal({ supabase, insights, onClose, onSaved }: { supabase: SupabaseClient; insights: Insight[]; onClose: () => void; onSaved: () => Promise<void> }) {
  const [title, setTitle] = useState("");
  const [type, setType] = useState<ActionItem["type"]>("test");
  const [priority, setPriority] = useState(3);
  const [insightId, setInsightId] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (title.trim().length < 3) { setError("נא להזין כותרת."); return; }
    setBusy(true); setError("");
    const { error: insertError } = await supabase.from("growth_actions").insert({
      title: title.trim(), type, priority, notes: notes.trim() || null, insight_id: insightId || null, status: "open",
    });
    setBusy(false);
    if (insertError) { setError(insertError.message); return; }
    await onSaved();
  }

  return (
    <GModal title="פעולה חדשה" eyebrow="Growth" onClose={onClose}>
      <form onSubmit={submit} className="form-stack">
        <label><span>כותרת</span><input value={title} onChange={(e) => setTitle(e.target.value)} required /></label>
        <div className="form-grid">
          <label><span>סוג</span>
            <select value={type} onChange={(e) => setType(e.target.value as ActionItem["type"])}>
              <option value="do_now">לביצוע מיידי</option>
              <option value="test">לבדיקה</option>
              <option value="watch">למעקב</option>
              <option value="ignore">להתעלמות</option>
            </select>
          </label>
          <label><span>עדיפות (1=גבוה)</span><input type="number" min={1} max={5} value={priority} onChange={(e) => setPriority(Number(e.target.value))} /></label>
        </div>
        {insights.length ? (
          <label><span>קשור לתובנה (לא חובה)</span>
            <select value={insightId} onChange={(e) => setInsightId(e.target.value)}>
              <option value="">— ללא —</option>
              {insights.map((i) => <option key={i.id} value={i.id}>{i.finding.slice(0, 60)}</option>)}
            </select>
          </label>
        ) : null}
        <label><span>הערות</span><textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} /></label>
        {error ? <p className="form-error">{error}</p> : null}
        <div className="modal-actions"><button type="submit" className="primary-button" disabled={busy}>{busy ? "שומר…" : "שמירה"}</button></div>
      </form>
    </GModal>
  );
}

// ---------------------------------------------------------------------------
// Experiments (section 10)
// ---------------------------------------------------------------------------

const EXPERIMENT_STATUS_LABELS: Record<Experiment["status"], string> = { draft: "טיוטה", running: "רץ", won: "ניצחון", lost: "הפסד", inconclusive: "לא חד משמעי", archived: "בארכיון" };

function ExperimentsView({ supabase, experiments, reload }: { supabase: SupabaseClient; experiments: Experiment[]; reload: () => Promise<void> }) {
  const [modalOpen, setModalOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function setStatus(id: string, status: Experiment["status"]) {
    setBusy(true);
    await supabase.from("growth_experiments").update({ status }).eq("id", id);
    await reload();
    setBusy(false);
  }

  return (
    <div className="page-content" style={{ padding: 0 }}>
      <section className="toolbar-card">
        <button className="primary-button" onClick={() => setModalOpen(true)}>+ ניסוי חדש</button>
      </section>
      <section className="section-card">
        <div className="section-title"><div><span className="eyebrow">מרשם ניסויים</span><h2>הכול במקום אחד</h2></div></div>
        {experiments.length ? (
          <div className="table-wrap">
            <table>
              <thead><tr><th>שם</th><th>אזור</th><th>מדד עיקרי</th><th>סטטוס</th><th></th></tr></thead>
              <tbody>
                {experiments.map((exp) => (
                  <tr key={exp.id}>
                    <td>{exp.name}</td>
                    <td>{exp.area || "—"}</td>
                    <td>{exp.primary_metric || "—"}</td>
                    <td><span className={`status ${exp.status === "won" ? "approved" : exp.status === "lost" ? "rejected" : exp.status === "running" ? "pending" : "completed"}`}>{EXPERIMENT_STATUS_LABELS[exp.status]}</span></td>
                    <td className="row-actions">
                      {exp.status === "draft" ? <button className="small-button" disabled={busy} onClick={() => setStatus(exp.id, "running")}>הפעלה</button> : null}
                      {exp.status === "running" ? (
                        <>
                          <button className="small-button success" disabled={busy} onClick={() => setStatus(exp.id, "won")}>ניצחון</button>
                          <button className="small-button danger" disabled={busy} onClick={() => setStatus(exp.id, "lost")}>הפסד</button>
                        </>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <GEmpty>עוד לא נרשמו ניסויים.</GEmpty>}
      </section>
      {modalOpen ? <NewExperimentModal supabase={supabase} onClose={() => setModalOpen(false)} onSaved={async () => { setModalOpen(false); await reload(); }} /> : null}
    </div>
  );
}

function NewExperimentModal({ supabase, onClose, onSaved }: { supabase: SupabaseClient; onClose: () => void; onSaved: () => Promise<void> }) {
  const [name, setName] = useState("");
  const [hypothesis, setHypothesis] = useState("");
  const [area, setArea] = useState("");
  const [primaryMetric, setPrimaryMetric] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (name.trim().length < 3) { setError("נא להזין שם לניסוי."); return; }
    setBusy(true); setError("");
    const { error: insertError } = await supabase.from("growth_experiments").insert({
      name: name.trim(), hypothesis: hypothesis.trim() || null, area: area.trim() || null,
      primary_metric: primaryMetric.trim() || null, status: "draft",
    });
    setBusy(false);
    if (insertError) { setError(insertError.message); return; }
    await onSaved();
  }

  return (
    <GModal title="ניסוי חדש" eyebrow="Growth" onClose={onClose}>
      <form onSubmit={submit} className="form-stack">
        <label><span>שם הניסוי</span><input value={name} onChange={(e) => setName(e.target.value)} required /></label>
        <label><span>השערה</span><textarea value={hypothesis} onChange={(e) => setHypothesis(e.target.value)} rows={2} /></label>
        <div className="form-grid">
          <label><span>אזור</span><input value={area} onChange={(e) => setArea(e.target.value)} placeholder="לדוגמה: דף הבית" /></label>
          <label><span>מדד עיקרי</span><input value={primaryMetric} onChange={(e) => setPrimaryMetric(e.target.value)} placeholder="לדוגמה: שיעור המרה" /></label>
        </div>
        {error ? <p className="form-error">{error}</p> : null}
        <div className="modal-actions"><button type="submit" className="primary-button" disabled={busy}>{busy ? "שומר…" : "שמירה"}</button></div>
      </form>
    </GModal>
  );
}

// ---------------------------------------------------------------------------
// Campaigns (sections 5, 16) — CSV import, idempotent via the DB unique
// constraint on (campaign_id, metric_date, source).
// ---------------------------------------------------------------------------

function CampaignsView({ supabase, campaigns, campaignMetrics, events, linkByRef, jobById, reload }: {
  supabase: SupabaseClient; campaigns: Campaign[]; campaignMetrics: CampaignMetric[]; events: GrowthEvent[];
  linkByRef: Map<string, BookingJobLink>; jobById: Map<string, GrowthJob>; reload: () => Promise<void>;
}) {
  const [importOpen, setImportOpen] = useState(false);

  const rows = useMemo(() => campaigns.map((c) => {
    const spend = campaignMetrics.filter((m) => m.campaign_id === c.id).reduce((s, m) => s + m.spend, 0);
    // Heuristic match: campaign_external_id -> current_campaign_id, else name -> current_campaign.
    const matched = events.filter((e) => (c.campaign_external_id && e.current_campaign_id === c.campaign_external_id) || e.current_campaign === c.name);
    const sessions = new Set(matched.map((e) => e.session_id)).size;
    const confirmedRefs = new Set(matched.filter((e) => e.event_name === "booking_confirmed" && e.booking_ref).map((e) => e.booking_ref as string));
    let revenue = 0;
    for (const ref of confirmedRefs) {
      const link = linkByRef.get(ref);
      const job = link?.factory_job_id ? jobById.get(link.factory_job_id) : undefined;
      if (job) revenue += job.gross_amount;
    }
    return { campaign: c, spend, sessions, confirmed: confirmedRefs.size, revenue, roas: safeDiv(revenue, spend) };
  }), [campaigns, campaignMetrics, events, linkByRef, jobById]);

  return (
    <div className="page-content" style={{ padding: 0 }}>
      <section className="toolbar-card">
        <button className="primary-button" onClick={() => setImportOpen(true)}>ייבוא הוצאות מ-CSV</button>
      </section>
      <section className="section-card">
        <div className="section-title"><div><span className="eyebrow">קמפיינים</span><h2>ביצועים ורווחיות</h2></div></div>
        {rows.length ? (
          <div className="table-wrap">
            <table>
              <thead><tr><th>קמפיין</th><th>פלטפורמה</th><th>הוצאה</th><th>כניסות</th><th>הזמנות מאושרות</th><th>הכנסה</th><th>ROAS</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.campaign.id}>
                    <td>{r.campaign.name}</td>
                    <td>{PLATFORM_LABELS[r.campaign.platform] || r.campaign.platform}</td>
                    <td className="money-cell">{money.format(r.spend)}</td>
                    <td className="money-cell">{number.format(r.sessions)}</td>
                    <td className="money-cell">{number.format(r.confirmed)}</td>
                    <td className="money-cell">{money.format(r.revenue)}</td>
                    <td>{r.spend > 0 ? r.roas.toFixed(2) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <GEmpty>אין עדיין קמפיינים. חברו מקור הוצאות או העלו CSV.</GEmpty>}
        <p className="helper-text">התאמת קמפיין↔ביקורים היא לפי מזהה קמפיין (UTM) או שם מדויק — קמפיינים ללא UTM תואם לא יופיעו כאן עד שהשם/המזהה יתואמו.</p>
      </section>
      {importOpen ? <CsvImportModal supabase={supabase} campaigns={campaigns} onClose={() => setImportOpen(false)} onSaved={async () => { setImportOpen(false); await reload(); }} /> : null}
    </div>
  );
}

const PLATFORM_LABELS: Record<string, string> = { google_ads: "Google Ads", meta_ads: "Meta Ads", tiktok: "TikTok", manual: "ידני", organic: "אורגני", influencer: "משפיענים", referral: "הפניה", other: "אחר" };

// CSV columns per master build doc section 16: platform, date, campaign id/name, spend, impressions, clicks.
function CsvImportModal({ supabase, campaigns, onClose, onSaved }: { supabase: SupabaseClient; campaigns: Campaign[]; onClose: () => void; onSaved: () => Promise<void> }) {
  const [text, setText] = useState("platform,date,campaign_name,campaign_id,spend,impressions,clicks\n");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ inserted: number; skipped: number; errors: string[] } | null>(null);

  async function run() {
    setBusy(true);
    setResult(null);
    const lines = text.trim().split(/\r?\n/).filter(Boolean);
    const header = lines.shift()?.split(",").map((h) => h.trim().toLowerCase()) || [];
    const col = (name: string) => header.indexOf(name);
    const errors: string[] = [];
    let inserted = 0, skipped = 0;

    // Cache campaign lookups/creations within this run to avoid duplicate inserts for repeated rows.
    const campaignCache = new Map<string, string>(campaigns.map((c) => [`${c.platform}|${c.campaign_external_id || ""}|${c.name}`, c.id]));

    for (const line of lines) {
      const cells = line.split(",").map((c) => c.trim());
      const platform = (cells[col("platform")] || "manual").toLowerCase();
      const date = cells[col("date")];
      const name = cells[col("campaign_name")];
      const externalId = cells[col("campaign_id")] || "";
      const spend = Number(cells[col("spend")] || 0);
      const impressions = Number(cells[col("impressions")] || 0);
      const clicks = Number(cells[col("clicks")] || 0);

      if (!date || !name || !Number.isFinite(spend)) { skipped += 1; errors.push(`שורה לא תקינה: ${line}`); continue; }

      const cacheKey = `${platform}|${externalId}|${name}`;
      let campaignId = campaignCache.get(cacheKey);
      if (!campaignId) {
        const { data: existing } = await supabase.from("growth_campaigns").select("id").eq("platform", platform).eq("name", name).maybeSingle();
        if (existing) {
          campaignId = existing.id;
        } else {
          const { data: created, error: createError } = await supabase.from("growth_campaigns")
            .insert({ platform, name, campaign_external_id: externalId || null }).select("id").single();
          if (createError || !created) { skipped += 1; errors.push(`נכשל ביצירת קמפיין: ${name}`); continue; }
          campaignId = created.id;
        }
        campaignCache.set(cacheKey, campaignId as string);
      }

      const { error: metricError } = await supabase.from("growth_campaign_daily_metrics")
        .upsert({ campaign_id: campaignId, metric_date: date, spend, impressions, clicks, source: "manual_csv" }, { onConflict: "campaign_id,metric_date,source" });
      if (metricError) { skipped += 1; errors.push(`נכשל בשמירת נתוני ${name} ל-${date}: ${metricError.message}`); continue; }
      inserted += 1;
    }

    await supabase.from("growth_import_runs").insert({
      import_type: "campaign_spend_csv", row_count: lines.length, inserted_count: inserted, skipped_count: skipped, errors,
    });

    setResult({ inserted, skipped, errors });
    setBusy(false);
  }

  return (
    <GModal title="ייבוא הוצאות מ-CSV" eyebrow="קמפיינים" onClose={onClose} wide>
      <div className="form-stack">
        <p className="helper-text">עמודות: platform, date (YYYY-MM-DD), campaign_name, campaign_id (לא חובה), spend, impressions, clicks. ייבוא חוזר לאותו קמפיין+תאריך מעדכן ולא משכפל.</p>
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={10} style={{ fontFamily: "monospace", direction: "ltr", textAlign: "left" }} />
        {result ? (
          <p className={result.errors.length ? "form-error" : "helper-text"}>
            נוספו/עודכנו {result.inserted} שורות, דולגו {result.skipped}.
            {result.errors.length ? ` שגיאות: ${result.errors.slice(0, 5).join(" | ")}` : ""}
          </p>
        ) : null}
        <div className="modal-actions">
          <button className="primary-button" disabled={busy} onClick={run}>{busy ? "מייבא…" : "ייבוא"}</button>
          {result ? <button className="secondary-button" onClick={async () => { await onSaved(); }}>סיום</button> : null}
        </div>
      </div>
    </GModal>
  );
}

// ---------------------------------------------------------------------------
// Profitability (section 8) + manual booking→job linking (section 7)
// ---------------------------------------------------------------------------

function ProfitabilityView({ supabase, jobs, links, events, reload }: {
  supabase: SupabaseClient; jobs: GrowthJob[]; links: BookingJobLink[]; events: GrowthEvent[]; reload: () => Promise<void>;
}) {
  const [linkModalRef, setLinkModalRef] = useState<string | null>(null);

  const linkedJobIds = new Set(links.filter((l) => l.status === "linked" && l.factory_job_id).map((l) => l.factory_job_id as string));
  const linkedJobs = jobs.filter((j) => linkedJobIds.has(j.id));

  const byService = useMemo(() => {
    const map = new Map<string, { jobs: number; gross: number; vat: number; employeePay: number; directExpenses: number; factoryNet: number }>();
    for (const j of linkedJobs) {
      const entry = map.get(j.service_type) || { jobs: 0, gross: 0, vat: 0, employeePay: 0, directExpenses: 0, factoryNet: 0 };
      entry.jobs += 1; entry.gross += j.gross_amount; entry.vat += j.vat_amount;
      entry.employeePay += j.employee_pay; entry.directExpenses += j.direct_expenses; entry.factoryNet += j.factory_net;
      map.set(j.service_type, entry);
    }
    return Array.from(map.entries()).map(([service, v]) => ({ service, ...v, margin: safeDiv(v.factoryNet, v.gross) })).sort((a, b) => b.factoryNet - a.factoryNet);
  }, [linkedJobs]);

  const confirmedRefs = Array.from(new Set(events.filter((e) => e.event_name === "booking_confirmed" && e.booking_ref).map((e) => e.booking_ref as string)));
  const linkedRefSet = new Set(links.filter((l) => l.status === "linked").map((l) => l.booking_ref));
  const unlinkedRefs = confirmedRefs.filter((r) => !linkedRefSet.has(r));

  return (
    <div className="page-content" style={{ padding: 0 }}>
      <section className="section-card">
        <div className="section-title"><div><span className="eyebrow">רווחיות</span><h2>לפי שירות (הזמנות מקושרות בלבד)</h2></div></div>
        {byService.length ? (
          <div className="table-wrap">
            <table>
              <thead><tr><th>שירות</th><th>עבודות</th><th>הכנסה לפני מע״מ</th><th>שכר עובדים</th><th>הוצאות ישירות</th><th>נטו לפקטורי</th><th>מרווח</th></tr></thead>
              <tbody>
                {byService.map((r) => (
                  <tr key={r.service}>
                    <td>{r.service}</td><td className="money-cell">{number.format(r.jobs)}</td><td className="money-cell">{money.format(r.gross)}</td>
                    <td className="money-cell">{money.format(r.employeePay)}</td><td className="money-cell">{money.format(r.directExpenses)}</td>
                    <td className="money-cell">{money.format(r.factoryNet)}</td><td>{pct(r.margin)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <GEmpty>אין עדיין עבודות מקושרות. קשרו הזמנות מאושרות לעבודות אמיתיות למטה כדי לראות רווחיות אמיתית.</GEmpty>}
      </section>

      <section className="section-card">
        <div className="section-title"><div><span className="eyebrow">קישור</span><h2>הזמנות מאושרות שטרם קושרו לעבודה ({unlinkedRefs.length})</h2></div></div>
        {unlinkedRefs.length ? (
          <div className="employee-summary-list">
            {unlinkedRefs.slice(0, 30).map((ref) => (
              <article key={ref}><div><strong>{ref}</strong></div><div><button className="small-button" onClick={() => setLinkModalRef(ref)}>קישור לעבודה</button></div></article>
            ))}
          </div>
        ) : <GEmpty>כל ההזמנות המאושרות מקושרות. 🎉</GEmpty>}
      </section>

      {linkModalRef ? (
        <LinkBookingModal supabase={supabase} bookingRef={linkModalRef} jobs={jobs} onClose={() => setLinkModalRef(null)} onSaved={async () => { setLinkModalRef(null); await reload(); }} />
      ) : null}
    </div>
  );
}

function LinkBookingModal({ supabase, bookingRef, jobs, onClose, onSaved }: {
  supabase: SupabaseClient; bookingRef: string; jobs: GrowthJob[]; onClose: () => void; onSaved: () => Promise<void>;
}) {
  const [search, setSearch] = useState("");
  const [selectedJobId, setSelectedJobId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const recent = jobs.slice(0, 200); // already sorted by job_date desc from loadAll
    if (!q) return recent.slice(0, 20);
    return recent.filter((j) => j.service_type.toLowerCase().includes(q) || j.city?.toLowerCase().includes(q) || String(j.gross_amount).includes(q)).slice(0, 20);
  }, [jobs, search]);

  async function submit() {
    if (!selectedJobId) { setError("נא לבחור עבודה."); return; }
    setBusy(true); setError("");
    const { error: upsertError } = await supabase.from("growth_booking_job_links").upsert(
      { booking_ref: bookingRef, factory_job_id: selectedJobId, link_method: "manual", status: "linked", confidence: 100 },
      { onConflict: "booking_ref" },
    );
    setBusy(false);
    if (upsertError) { setError(upsertError.message); return; }
    await onSaved();
  }

  return (
    <GModal title={`קישור הזמנה ${bookingRef} לעבודה`} eyebrow="Growth" onClose={onClose} wide>
      <div className="form-stack">
        <div className="search-field"><input placeholder="חיפוש לפי שירות / עיר / סכום" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
        <div className="table-wrap">
          <table>
            <thead><tr><th></th><th>תאריך</th><th>שירות</th><th>עיר</th><th>סכום</th></tr></thead>
            <tbody>
              {filtered.map((j) => (
                <tr key={j.id} onClick={() => setSelectedJobId(j.id)} style={{ cursor: "pointer", background: selectedJobId === j.id ? "var(--soft)" : undefined }}>
                  <td><input type="radio" checked={selectedJobId === j.id} onChange={() => setSelectedJobId(j.id)} /></td>
                  <td>{j.job_date}</td><td>{j.service_type}</td><td>{j.city || "—"}</td><td className="money-cell">{money.format(j.gross_amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {error ? <p className="form-error">{error}</p> : null}
        <div className="modal-actions"><button className="primary-button" disabled={busy || !selectedJobId} onClick={submit}>{busy ? "מקשר…" : "קישור"}</button></div>
      </div>
    </GModal>
  );
}

// ---------------------------------------------------------------------------
// AI Insights (section 11) — deterministic rules only, no LLM call in V1
// (master build doc: "deterministic insight rules should work first").
// ---------------------------------------------------------------------------

function AIInsightsView({ supabase, insights, events, links, jobById, reload }: {
  supabase: SupabaseClient; insights: Insight[]; events: GrowthEvent[]; links: BookingJobLink[]; jobById: Map<string, GrowthJob>; reload: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const computed = useMemo(() => computeDeterministicInsights(events, links), [events, links]);

  async function persistAndCreateAction(finding: typeof computed[number]) {
    setBusy(true);
    const { data: created, error } = await supabase.from("growth_ai_insights").insert({
      type: finding.type, finding: finding.finding, evidence: finding.evidence, likely_explanation: finding.likely_explanation,
      confidence: finding.confidence, business_impact: finding.business_impact, recommended_action: finding.recommended_action,
      measurement_plan: finding.measurement_plan,
    }).select("id").single();
    if (!error && created) {
      await supabase.from("growth_actions").insert({ title: finding.recommended_action, insight_id: created.id, type: "test", priority: 2, status: "open" });
    }
    await reload();
    setBusy(false);
  }

  async function dismiss(id: string) {
    setBusy(true);
    await supabase.from("growth_ai_insights").update({ dismissed: true }).eq("id", id);
    await reload();
    setBusy(false);
  }

  return (
    <div className="page-content" style={{ padding: 0 }}>
      <section className="section-card">
        <div className="section-title"><div><span className="eyebrow">תובנות חדשות</span><h2>מבוססות כללים, לא LLM (V1)</h2></div></div>
        {computed.length ? (
          <div className="employee-summary-list">
            {computed.map((f, i) => (
              <article key={i} style={{ display: "block" }}>
                <div style={{ marginBottom: 8 }}><strong>{f.finding}</strong></div>
                <p className="helper-text" style={{ margin: "0 0 8px" }}>{f.likely_explanation} · ביטחון {f.confidence}%</p>
                <button className="small-button" disabled={busy} onClick={() => persistAndCreateAction(f)}>→ צור פעולה: {f.recommended_action}</button>
              </article>
            ))}
          </div>
        ) : <GEmpty>אין עדיין מספיק נתונים כדי לייצר תובנות. חוזרים לכאן ברגע שיצטברו יותר אירועים.</GEmpty>}
      </section>

      {insights.length ? (
        <section className="section-card">
          <div className="section-title"><div><span className="eyebrow">נשמרו</span><h2>תובנות פעילות</h2></div></div>
          <div className="employee-summary-list">
            {insights.map((ins) => (
              <article key={ins.id}><div><strong>{ins.finding}</strong><span>{ins.recommended_action}</span></div><div><button className="small-button" disabled={busy} onClick={() => dismiss(ins.id)}>סגירה</button></div></article>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function computeDeterministicInsights(events: GrowthEvent[], links: BookingJobLink[]) {
  const findings: {
    type: Insight["type"]; finding: string; evidence: Record<string, unknown>; likely_explanation: string;
    confidence: number; business_impact: string; recommended_action: string; measurement_plan: string;
  }[] = [];

  // Rule 1: biggest funnel drop between consecutive stages.
  const stageCounts = FUNNEL_STAGES.map((s) => ({ label: s.label, sessions: new Set(events.filter((e) => e.event_name === s.name).map((e) => e.session_id)).size }));
  let worstDrop = { from: "", to: "", rate: 0 };
  for (let i = 1; i < stageCounts.length; i++) {
    const prev = stageCounts[i - 1].sessions;
    const curr = stageCounts[i].sessions;
    if (prev < 20) continue; // avoid noisy conclusions on tiny samples (doc section S)
    const dropRate = 1 - safeDiv(curr, prev);
    if (dropRate > worstDrop.rate) worstDrop = { from: stageCounts[i - 1].label, to: stageCounts[i].label, rate: dropRate };
  }
  if (worstDrop.rate > 0.5) {
    findings.push({
      type: "funnel_leak",
      finding: `הנשירה הגדולה ביותר במשפך היא בין "${worstDrop.from}" ל"${worstDrop.to}" — ${pct(worstDrop.rate)}.`,
      evidence: { from: worstDrop.from, to: worstDrop.to, dropRate: worstDrop.rate },
      likely_explanation: "ייתכן חיכוך בשלב הזה בתהליך ההזמנה או חוסר בהירות במידע המוצג.",
      confidence: worstDrop.rate > 0.7 ? 70 : 55,
      business_impact: "כל נקודה אחוז שיפור כאן מתורגמת ישירות ליותר הזמנות מאושרות.",
      recommended_action: `לבדוק את שלב "${worstDrop.to}" בפועל ולזהות חסמים`,
      measurement_plan: "מעקב אחרי שיעור ההמרה בין השלבים בשבועיים הקרובים.",
    });
  }

  // Rule 2: source quality flag — meaningful sessions, zero confirmations.
  const sessionsBySource = new Map<string, Set<string>>();
  const confirmedBySource = new Map<string, number>();
  for (const e of events) {
    const source = e.current_source || "לא ידוע";
    if (!sessionsBySource.has(source)) sessionsBySource.set(source, new Set());
    sessionsBySource.get(source)!.add(e.session_id);
    if (e.event_name === "booking_confirmed") confirmedBySource.set(source, (confirmedBySource.get(source) || 0) + 1);
  }
  for (const [source, sessions] of sessionsBySource) {
    if (sessions.size >= 30 && !confirmedBySource.get(source)) {
      findings.push({
        type: "problem",
        finding: `המקור "${source}" הביא ${sessions.size} כניסות ואף לא הזמנה מאושרת אחת.`,
        evidence: { source, sessions: sessions.size },
        likely_explanation: "תנועה באיכות נמוכה מהמקור הזה, או חוסר התאמה בין המסר לציפייה.",
        confidence: 60,
        business_impact: "כנראה תקציב/מאמץ שלא מניב כרגע החזר.",
        recommended_action: `לבדוק את איכות התנועה מ-${source} לפני השקעה נוספת`,
        measurement_plan: "השוואת שיעור ההמרה של המקור הזה למקורות אחרים על פני 30 ימים.",
      });
    }
  }

  // Rule 3: data quality — many confirmed bookings still unlinked.
  const confirmedRefs = new Set(events.filter((e) => e.event_name === "booking_confirmed" && e.booking_ref).map((e) => e.booking_ref as string));
  const linkedRefs = new Set(links.filter((l) => l.status === "linked").map((l) => l.booking_ref));
  const unlinked = Array.from(confirmedRefs).filter((r) => !linkedRefs.has(r));
  if (confirmedRefs.size >= 5 && unlinked.length / confirmedRefs.size > 0.3) {
    findings.push({
      type: "data_quality",
      finding: `${unlinked.length} מתוך ${confirmedRefs.size} הזמנות מאושרות עדיין לא מקושרות לעבודה אמיתית.`,
      evidence: { unlinked: unlinked.length, total: confirmedRefs.size },
      likely_explanation: "קישור ידני עדיין לא בוצע, או שהעבודה המתאימה טרם נוצרה במערכת.",
      confidence: 90,
      business_impact: "בלי קישור, מסכי הרווחיות לא משקפים את התמונה המלאה.",
      recommended_action: "לקשר הזמנות ממתינות במסך הרווחיות",
      measurement_plan: "לעקוב אחרי אחוז הקישור מדי שבוע.",
    });
  }

  return findings;
}
