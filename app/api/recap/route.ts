import { weeklyRecap } from "@/lib/graph";

export const dynamic = "force-dynamic";

/** GET /api/recap — "what I learned this week": growth made visible. */
export async function GET() {
  return Response.json(await weeklyRecap());
}
