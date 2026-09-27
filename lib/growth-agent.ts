import { Output, ToolLoopAgent, isStepCount, tool } from "ai";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";

type Trigger = "manual" | "scheduled";
type AgentSettings = {
  enabled: boolean;
  autonomy_level: "observe" | "balanced" | "aggressive";
  max_actions_per_run: number;
  require_approval_for_external_changes: boolean;
};

const insightType = z.enum([
  "opportunity", "problem", "anomaly", "budget_efficiency", "funnel_leak",
  "retention", "creative", "data_quality", "experiment_suggestion",
]);

function dateOnly(date: Date) {
  return date.toISOString().slice(0, 10);
}

function daysAgo(days: number) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date;
}

function ratio(a: number, b: number) {
  return b > 0 ? Math.round((a / b) * 1000) / 10 : 0;
}

async function buildSnapshot(db: SupabaseClient) {
  const currentFrom = daysAgo(30);
  const previousFrom = daysAgo(60);
  const now = new Date();
  const [eventsResult, jobsResult, campaignsResult, metricsResult, actionsResult, insightsResult] = await Promise.all([
    db.from("growth_events")
      .select("event_name,session_id,service_type,city,current_source,booking_ref,occurred_at")
      .gte("occurred_at", previousFrom.toISOString()).order("occurred_at", { ascending: false }).limit(20000),
    db.from("jobs")
      .select("job_date,service_type,city,status,gross_amount,factory_net")
      .in("status", ["approved", "completed"]).gte("job_date", dateOnly(previousFrom)).limit(5000),
    db.from("growth_campaigns").select("id,name,platform,status,service_type,city"),
    db.from("growth_campaign_daily_metrics")
      .select("campaign_id,metric_date,spend,impressions,clicks").gte("metric_date", dateOnly(previousFrom)).limit(10000),
    db.from("growth_actions").select("title,type,priority,status,created_at").in("status", ["open", "in_progress"]).limit(100),
    db.from("growth_ai_insights").select("finding,recommended_action,created_at").eq("dismissed", false).limit(50),
  ]);
  const error = [eventsResult, jobsResult, campaignsResult, metricsResult, actionsResult, insightsResult].find((r) => r.error)?.error;
  if (error) throw error;

  const events = eventsResult.data || [];
  const jobs = jobsResult.data || [];
  const metrics = metricsResult.data || [];
  const split = currentFrom.getTime();

  function summarizePeriod(from: number, to: number) {
    const periodEvents = events.filter((event) => {
      const time = new Date(event.occurred_at).getTime();
      return time >= from && time < to;
    });
    const eventCount = (name: string) => new Set(periodEvents.filter((e) => e.event_name === name).map((e) => e.session_id)).size;
    const sessions = new Set(periodEvents.map((e) => e.session_id)).size;
    const confirmed = new Set(periodEvents.filter((e) => e.event_name === "booking_confirmed").map((e) => e.booking_ref).filter(Boolean)).size;
    const bySource: Record<string, { sessions: Set<string>; confirmed: Set<string> }> = {};
    for (const event of periodEvents) {
      const source = event.current_source || "unknown";
      bySource[source] ||= { sessions: new Set(), confirmed: new Set() };
      bySource[source].sessions.add(event.session_id);
      if (event.event_name === "booking_confirmed" && event.booking_ref) bySource[source].confirmed.add(event.booking_ref);
    }
    return {
      sessions,
      serviceViews: eventCount("service_view"),
      priceViews: eventCount("price_view"),
      bookingStarts: eventCount("booking_started"),
      bookingSubmitted: eventCount("booking_submitted"),
      confirmed,
      conversionPercent: ratio(confirmed, sessions),
      sources: Object.fromEntries(Object.entries(bySource).map(([source, value]) => [source, {
        sessions: value.sessions.size,
        confirmed: value.confirmed.size,
        conversionPercent: ratio(value.confirmed.size, value.sessions.size),
      }])),
    };
  }

  const currentJobs = jobs.filter((job) => new Date(`${job.job_date}T00:00:00Z`).getTime() >= split);
  const currentMetrics = metrics.filter((metric) => new Date(`${metric.metric_date}T00:00:00Z`).getTime() >= split);
  const snapshot = {
    generatedAt: now.toISOString(),
    period: { from: dateOnly(currentFrom), to: dateOnly(now), days: 30 },
    current: summarizePeriod(split, now.getTime() + 1),
    previous: summarizePeriod(previousFrom.getTime(), split),
    business: {
      completedJobs: currentJobs.length,
      revenueBeforeVat: currentJobs.reduce((sum, job) => sum + Number(job.gross_amount || 0), 0),
      factoryNet: currentJobs.reduce((sum, job) => sum + Number(job.factory_net || 0), 0),
      marketingSpend: currentMetrics.reduce((sum, metric) => sum + Number(metric.spend || 0), 0),
      clicks: currentMetrics.reduce((sum, metric) => sum + Number(metric.clicks || 0), 0),
      impressions: currentMetrics.reduce((sum, metric) => sum + Number(metric.impressions || 0), 0),
    },
    campaigns: campaignsResult.data || [],
    openActions: actionsResult.data || [],
    activeInsights: insightsResult.data || [],
    dataHealth: {
      eventsAvailable: events.length,
      latestEventAt: events[0]?.occurred_at || null,
      campaignMetricsAvailable: metrics.length,
      warning: events.length >= 20000 ? "event query reached its safety limit" : null,
    },
  };
  return snapshot;
}

function buildAgent(db: SupabaseClient, runId: string, settings: AgentSettings, counters: { insights: number; actions: number; approvals: number }) {
  return new ToolLoopAgent({
    model: "inclusionai/ling-3.0-flash-sante-free",
    instructions: `אתה מנהל הצמיחה האקטיבי של Factory Clean, עסק ישראלי לשירותי ניקוי מקצועיים.
המטרה שלך היא להגדיל הזמנות מאושרות ורווח נקי, תוך שמירה על אמינות הנתונים והמותג.

כללים מחייבים:
1. פעל על בסיס המספרים שקיבלת בלבד. אל תמציא סיבות, הכנסות או ביצועים.
2. בדוק קודם את בריאות הנתונים. כאשר המדגם קטן, ציין זאת והורד ביטחון.
3. חפש צוואר בקבוק במשפך, מקור תנועה חלש/חזק, הזדמנות בשירות או עיר, בזבוז תקציב, ובעיית קישור בין הזמנות לעבודות.
4. אל תחזור על תובנה או פעולה שכבר מופיעה ברשימות הפעילות.
5. שמור רק תובנות משמעותיות. צור לכל היותר ${settings.max_actions_per_run} פעולות בריצה.
6. מותר לך עצמאית לשמור תובנה וליצור משימת בדיקה, מדידה, מעקב או תיקון פנימי.
7. שינוי תקציב, עצירת/הפעלת קמפיין, פרסום תוכן, שליחת הודעה ללקוחות או שינוי באתר דורשים requestApproval. לעולם אל תציג אותם כאילו בוצעו.
8. תן פעולות ממוקדות: מה לעשות, למה, איזה מדד יוכיח הצלחה ובאיזה טווח זמן.
9. כתוב בעברית קצרה, ישירה ועסקית.`,
    stopWhen: isStepCount(8),
    output: Output.object({
      schema: z.object({
        executiveSummary: z.string().min(20).max(1200),
        health: z.enum(["good", "attention", "critical"]),
        topPriority: z.string().min(5).max(300),
      }),
    }),
    tools: {
      saveInsight: tool({
        description: "שמור תובנה עסקית חדשה שנתמכת בראיות מספריות",
        inputSchema: z.object({
          type: insightType,
          finding: z.string().min(10).max(500),
          evidence: z.record(z.string(), z.unknown()),
          likelyExplanation: z.string().max(500),
          confidence: z.number().min(0).max(100),
          businessImpact: z.string().max(500),
          recommendedAction: z.string().min(5).max(500),
          measurementPlan: z.string().min(5).max(500),
        }),
        execute: async (input) => {
          const { data: duplicate } = await db.from("growth_ai_insights").select("id").eq("finding", input.finding).eq("dismissed", false).maybeSingle();
          if (duplicate) return { saved: false, reason: "duplicate" };
          const { data, error } = await db.from("growth_ai_insights").insert({
            type: input.type, finding: input.finding, evidence: { ...input.evidence, agent_run_id: runId },
            likely_explanation: input.likelyExplanation, confidence: input.confidence,
            business_impact: input.businessImpact, recommended_action: input.recommendedAction,
            measurement_plan: input.measurementPlan,
          }).select("id").single();
          if (error) throw error;
          counters.insights += 1;
          return { saved: true, id: data.id };
        },
      }),
      createInternalAction: tool({
        description: "צור משימה פנימית בטוחה שאינה משנה קמפיין, תקציב, אתר או תקשורת חיצונית",
        inputSchema: z.object({
          title: z.string().min(5).max(300),
          type: z.enum(["do_now", "test", "watch"]),
          priority: z.number().int().min(1).max(5),
          expectedImpact: z.string().max(500),
          metric: z.string().max(300),
          notes: z.string().max(1000),
        }),
        execute: async (input) => {
          if (settings.autonomy_level === "observe") return { created: false, reason: "observe mode" };
          if (counters.actions >= settings.max_actions_per_run) return { created: false, reason: "run limit" };
          const { data: duplicate } = await db.from("growth_actions").select("id").eq("title", input.title).in("status", ["open", "in_progress"]).maybeSingle();
          if (duplicate) return { created: false, reason: "duplicate" };
          const { data, error } = await db.from("growth_actions").insert({
            title: input.title, type: input.type, priority: input.priority, status: "open",
            expected_impact: input.expectedImpact, metric: input.metric,
            notes: `${input.notes}\nנוצר אוטומטית על ידי Growth AI · run ${runId}`,
          }).select("id").single();
          if (error) throw error;
          counters.actions += 1;
          return { created: true, id: data.id };
        },
      }),
      requestApproval: tool({
        description: "בקש אישור מבעל העסק לפני פעולה חיצונית או רגישה",
        inputSchema: z.object({
          actionType: z.enum(["campaign_budget", "campaign_status", "website_change", "publish_content", "customer_message", "other"]),
          title: z.string().min(5).max(300),
          rationale: z.string().min(10).max(1000),
          expectedImpact: z.string().max(500),
          riskLevel: z.enum(["low", "medium", "high"]),
          payload: z.record(z.string(), z.unknown()),
        }),
        execute: async (input) => {
          const { data: duplicate } = await db.from("growth_agent_approvals").select("id").eq("title", input.title).eq("status", "pending").maybeSingle();
          if (duplicate) return { created: false, reason: "duplicate" };
          const { data, error } = await db.from("growth_agent_approvals").insert({
            run_id: runId, action_type: input.actionType, title: input.title,
            rationale: input.rationale, expected_impact: input.expectedImpact,
            risk_level: input.riskLevel, payload: input.payload, status: "pending",
          }).select("id").single();
          if (error) throw error;
          counters.approvals += 1;
          return { created: true, id: data.id, status: "pending" };
        },
      }),
    },
  });
}

export async function runGrowthAgent(db: SupabaseClient, trigger: Trigger) {
  const { data: settingsRow, error: settingsError } = await db.from("growth_agent_settings").select("*").eq("id", true).single();
  if (settingsError) throw settingsError;
  const settings = settingsRow as AgentSettings;
  const snapshot = await buildSnapshot(db);
  const { data: run, error: runError } = await db.from("growth_agent_runs").insert({
    trigger, status: settings.enabled ? "running" : "skipped",
    period_from: snapshot.period.from, period_to: snapshot.period.to, data_snapshot: snapshot,
    completed_at: settings.enabled ? null : new Date().toISOString(),
    executive_summary: settings.enabled ? null : "הסוכן כבוי בהגדרות.",
  }).select("id").single();
  if (runError) throw runError;
  if (!settings.enabled) return { runId: run.id, status: "skipped" as const };

  const counters = { insights: 0, actions: 0, approvals: 0 };
  try {
    const agent = buildAgent(db, run.id, settings, counters);
    const result = await agent.generate({
      prompt: `נתח את תמונת המצב הבאה. שמור תובנות ופתח פעולות רק כאשר הראיות מצדיקות זאת. בסיום החזר תקציר מנהלים ועדיפות אחת עליונה.\n\n${JSON.stringify(snapshot)}`,
    });
    await db.from("growth_agent_runs").update({
      status: "completed", executive_summary: result.output.executiveSummary,
      insights_created: counters.insights, actions_created: counters.actions,
      approvals_created: counters.approvals, completed_at: new Date().toISOString(),
    }).eq("id", run.id);
    return { runId: run.id, status: "completed" as const, ...result.output, ...counters };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown agent error";
    await db.from("growth_agent_runs").update({ status: "failed", error_message: message.slice(0, 1000), completed_at: new Date().toISOString() }).eq("id", run.id);
    throw error;
  }
}
