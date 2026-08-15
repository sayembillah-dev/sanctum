import { addFeedback } from "@/lib/graph";
import { requireUser } from "@/lib/auth";

/** POST /api/feedback — 👍/👎 on a reply. Consolidation reads these to correct itself. */
export async function POST(req: Request) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { rating, userMsg, assistantMsg } = await req.json();
  if (![1, -1].includes(rating) || typeof assistantMsg !== "string" || !assistantMsg.trim()) {
    return Response.json({ error: "rating (1|-1) and assistantMsg required" }, { status: 400 });
  }
  await addFeedback({ rating, userMsg: typeof userMsg === "string" ? userMsg : "", assistantMsg });
  return Response.json({ ok: true });
}
