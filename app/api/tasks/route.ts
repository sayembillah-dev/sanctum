import { listTasks, setTaskStatus } from "@/lib/graph";

export const dynamic = "force-dynamic"; // tasks are live memory — never cache

/** GET /api/tasks — the memory graph's Task nodes as an actionable list
 *  (open first, overdue flagged). The tasks view reads this. */
export async function GET() {
  return Response.json({ tasks: await listTasks() });
}

/** POST /api/tasks — { id, done }: toggle a task's status from the UI.
 *  Same attrs.status the extractor/open-loops read — one source of truth. */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  if (typeof body?.id !== "string" || typeof body?.done !== "boolean") {
    return Response.json({ error: "id + done (boolean) required" }, { status: 400 });
  }
  const r = await setTaskStatus(body.id, body.done);
  if (!r) return Response.json({ error: "task not found" }, { status: 404 });
  return Response.json({ ok: true, ...r });
}
