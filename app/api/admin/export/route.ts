import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { buildVault, zipVault } from "@/lib/mirror";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** GET /api/admin/export — your memories, portable.
 *  Default: full backup of the brain as one JSON file — dumps, nodes (incl.
 *  soft-closed history; embeddings excluded), edges, feedback, chat messages.
 *  ?format=vault: regenerate the Obsidian-ready markdown mirror on disk
 *  (mirror/: dumps as chronological day files = source of truth, nodes as
 *  [[wiki-linked]] notes, forgotten nodes in graveyard/) and download it as
 *  one zip — open it in Obsidian and the brain is browsable without Sanctum.
 *  Auth: admin session required (it's the whole brain). */
export async function GET(req: Request) {
  if (!(await requireAdmin())) {
    return Response.json({ error: "admin only" }, { status: 403 });
  }

  if (new URL(req.url).searchParams.get("format") === "vault") {
    const stats = await buildVault();
    const zip = await zipVault();
    const date = new Date().toISOString().slice(0, 10);
    return new Response(new Blob([zip], { type: "application/zip" }), {
      headers: {
        "Content-Disposition": `attachment; filename="sanctum-vault-${date}.zip"`,
        "X-Vault-Stats": JSON.stringify({ ...stats, dir: undefined }),
      },
    });
  }

  const [dumps, nodes, edges, feedback, chatMessages] = await Promise.all([
    prisma.dump.findMany({ orderBy: { created_at: "asc" } }),
    prisma.node.findMany({ orderBy: { created_at: "asc" } }),
    prisma.edge.findMany({ orderBy: { created_at: "asc" } }),
    prisma.feedback.findMany({ orderBy: { created_at: "asc" } }),
    prisma.chatMessage.findMany({ orderBy: { created_at: "asc" } }),
  ]);
  const date = new Date().toISOString().slice(0, 10);
  return new Response(
    JSON.stringify(
      { exportedAt: new Date().toISOString(), dumps, nodes, edges, feedback, chatMessages },
      null,
      2
    ),
    {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="sanctum-export-${date}.json"`,
      },
    }
  );
}
