import { runConsolidation } from "@/lib/agent";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * /api/admin/consolidate — the sleep cycle.
 * POST (manual): default dry run — promotes profile attrs, returns merge
 *   proposals + stale candidates. Body { "apply": true }: also applies merges.
 * GET (Vercel Cron, nightly): DRY RUN only — proposes merges + reports stale
 *   candidates without touching the graph. Merges are applied explicitly via
 *   POST {"apply": true}, so a bad auto-merge can never mangle history.
 *
 * Auth: when CRON_SECRET is set (production), callers must send
 * `Authorization: Bearer <CRON_SECRET>` — Vercel Cron does this automatically.
 * Unset (local dev), the endpoint stays open for convenience.
 */
function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

export async function POST(req: Request) {
  if (!authorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  return Response.json(await runConsolidation({ apply: body?.apply === true }));
}

export async function GET(req: Request) {
  if (!authorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
  return Response.json(await runConsolidation({ apply: false }));
}
