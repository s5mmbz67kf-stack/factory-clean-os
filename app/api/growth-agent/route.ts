import { NextRequest } from "next/server";
import { ApiError, failure, response, staff } from "@/lib/partner-server";
import { runGrowthAgent } from "@/lib/growth-agent";

export const maxDuration = 300;

export async function POST(request: NextRequest) {
  try {
    const { db, admin } = await staff(request);
    if (!admin) throw new ApiError(403, "מנהל בלבד.");

    const { data: activeRun } = await db.from("growth_agent_runs")
      .select("id,started_at").eq("status", "running")
      .gte("started_at", new Date(Date.now() - 15 * 60 * 1000).toISOString()).maybeSingle();
    if (activeRun) throw new ApiError(409, "הסוכן כבר מנתח את הנתונים. המתינו לסיום הריצה.");

    const result = await runGrowthAgent(db, "manual");
    return response({ ok: true, ...result });
  } catch (error) {
    return failure(error);
  }
}
