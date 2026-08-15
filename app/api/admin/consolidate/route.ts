import { runConsolidation } from "@/lib/agent";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * POST /api/admin/consolidate — the sleep cycle.
 * Default: dry run — promotes profile attrs, returns merge proposals + stale candidates.
 * Body { "apply": true }: also applies the merge proposals (safe; history preserved).
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  return Response.json(await runConsolidation({ apply: body?.apply === true }));
}
