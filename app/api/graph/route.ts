import { graphSnapshot } from "@/lib/graph";

export const dynamic = "force-dynamic"; // never cache — the graph must be live

// Full graph snapshot for the neuron view. Includes pinned (the sun) + mention_count (size).
export async function GET() {
  return Response.json(await graphSnapshot());
}
