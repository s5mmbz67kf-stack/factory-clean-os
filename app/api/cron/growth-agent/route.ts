import { NextRequest, NextResponse } from "next/server";
import { dbClient } from "@/lib/partner-server";
import { runGrowthAgent } from "@/lib/growth-agent";

export const maxDuration = 300;

export async function GET(request: NextRequest) {
  if (!process.env.CRON_SECRET || request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const db = dbClient();
    const { data: recent } = await db.from("growth_agent_runs").select("id")
      .eq("trigger", "scheduled").gte("started_at", new Date(Date.now() - 20 * 60 * 60 * 1000).toISOString()).limit(1);
    if (recent?.length) return NextResponse.json({ ok: true, skipped: "already-ran-today" });
    const result = await runGrowthAgent(db, "scheduled");
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    console.error("[growth-agent-cron]", error);
    return NextResponse.json({ error: "Growth agent failed" }, { status: 500 });
  }
}
