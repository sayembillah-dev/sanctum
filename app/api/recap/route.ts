import { weeklyRecap } from "@/lib/graph";
import { requireUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** GET /api/recap — "what I learned this week": growth made visible. */
export async function GET() {
  const user = await requireUser();
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });
  return Response.json(await weeklyRecap());
}
