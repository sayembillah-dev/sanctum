import { graphSnapshot } from "@/lib/graph";
import { requireUser } from "@/lib/auth";

export const dynamic = "force-dynamic"; // never cache — the graph must be live

// Full graph snapshot for the neuron view. Includes pinned (the sun) + mention_count (size).
// 🕰️ ?as_of=YYYY-MM-DD → the graph as it was at the end of that day (time-travel).
export async function GET(req: Request) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });
  const asOf = new URL(req.url).searchParams.get("as_of") ?? undefined;
  return Response.json(await graphSnapshot(asOf));
}
