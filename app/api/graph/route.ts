import { graphSnapshot, graphVersion } from "@/lib/graph";
import { requireUser } from "@/lib/auth";

export const dynamic = "force-dynamic"; // never cache — the graph must be live

// Full graph snapshot for the neuron view. Includes pinned (the sun) + mention_count (size).
// 🕰️ ?as_of=YYYY-MM-DD → the graph as it was at the end of that day (time-travel).
// ⚡ ?v=<version> → 304 Not Modified when the graph hasn't changed since that version
//    (round-2 opt B6: idle polling costs one aggregate, not a full snapshot).
//    Time-travel (as_of) never participates in the probe — always a full snapshot.
export async function GET(req: Request) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });
  const url = new URL(req.url);
  const asOf = url.searchParams.get("as_of") ?? undefined;
  if (!asOf) {
    const v = await graphVersion();
    if (url.searchParams.get("v") === v) return new Response(null, { status: 304 });
    return Response.json(await graphSnapshot(), { headers: { "X-Graph-Version": v } });
  }
  return Response.json(await graphSnapshot(asOf));
}
