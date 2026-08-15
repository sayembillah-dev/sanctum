import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** GET /api/admin/export — full backup of the brain as one JSON file:
 *  dumps, nodes (incl. soft-closed history; embeddings excluded), edges,
 *  feedback, chat messages. Your memories, portable.
 *  Auth: admin session required (it's the whole brain). */
export async function GET() {
  if (!(await requireAdmin())) {
    return Response.json({ error: "admin only" }, { status: 403 });
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
