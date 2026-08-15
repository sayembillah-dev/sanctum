import { forgetNodeById, nodeDetail } from "@/lib/graph";

export const dynamic = "force-dynamic";

/** GET /api/graph/node?id=… — inspector payload for the cosmos:
 *  the node (attrs, salience stats) + its active neighborhood. */
export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("id") ?? "";
  const detail = id ? await nodeDetail(id) : null;
  if (!detail) return Response.json({ error: "node not found" }, { status: 404 });
  return Response.json(detail);
}

/** POST /api/graph/node — { id, action: "forget" }: explicit user-initiated
 *  forgetting from the inspector. Same soft-close path as chat-based forgetting;
 *  history preserved. The pinned profile node refuses (guard inside). */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  if (body?.action === "forget" && typeof body.id === "string") {
    const f = await forgetNodeById(body.id);
    if (!f) {
      return Response.json(
        { ok: false, error: "node not found, already forgotten, or pinned" },
        { status: 400 }
      );
    }
    return Response.json({ ok: true, forgotten: f.name });
  }
  return Response.json({ error: "unknown action" }, { status: 400 });
}
