import { prisma } from "@/lib/db";
import { runExtraction } from "@/lib/agent";
import { requireAdmin } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * POST /api/admin/rebuild — wipe nodes/edges and re-extract every dump in order.
 * Dumps are the source of truth; the graph is a derived view.
 * The pinned profile node is re-seeded by the first extraction.
 * Dev/prototype tool: heals graphs built before dedup + linking were fixed.
 *
 * Auth: admin session required (destructive — truncates the graph).
 */
export async function POST() {
  if (!(await requireAdmin())) {
    return Response.json({ error: "admin only" }, { status: 403 });
  }
  const dumps = await prisma.dump.findMany({
    orderBy: { created_at: "asc" },
    select: { raw_text: true },
  });
  if (!dumps.length) return Response.json({ ok: true, message: "no dumps — nothing to rebuild" });

  await prisma.$executeRawUnsafe(`truncate table edges, nodes, dumps restart identity`);

  const results = [];
  for (const d of dumps) {
    results.push(await runExtraction(d.raw_text));
  }

  const ok = results.filter((r) => r.ok);
  return Response.json({
    ok: true,
    dumps: dumps.length,
    succeeded: ok.length,
    nodesCreated: ok.reduce((a, r) => a + (r.ok ? r.nodes.created.length : 0), 0),
    edgesCreated: ok.reduce((a, r) => a + (r.ok ? r.edgesCreated : 0), 0),
    failures: results.filter((r) => !r.ok),
  });
}
