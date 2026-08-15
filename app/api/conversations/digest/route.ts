import { summarizeConversation, extractFromStretch } from "@/lib/agent";
import { currentSessionId, recentChatMessages, rotateSession } from "@/lib/graph";
import { requireUser } from "@/lib/auth";

export const maxDuration = 60;

/** POST /api/conversations/digest — explicit "session ended" (fired by clear-chat):
 *  crystallize the session into a digest node from the SERVER-SIDE transcript
 *  (the client no longer ships messages), then rotate to a fresh session.
 *  Session end is the LAST chance to sweep facts, so extraction runs here too —
 *  the 12-message cadence never fires for short sessions, and the tail since
 *  the last boundary holds whatever the remember tool didn't save. Both calls
 *  are awaited (allSettled so rotation always happens): this route is the
 *  backstop, never fire-and-forget. */
export async function POST() {
  const user = await requireUser();
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });
  const sessionId = await currentSessionId();
  const stretch = await recentChatMessages(sessionId, 40);
  const [digest, extraction] = await Promise.allSettled([
    summarizeConversation(stretch), // self-rejects when < 4 substantive
    extractFromStretch(stretch), // self-rejects on empty stretch
  ]);
  await rotateSession();
  return Response.json({
    digest: digest.status === "fulfilled" ? digest.value : { ok: false, error: String(digest.reason) },
    extraction:
      extraction.status === "fulfilled" ? extraction.value : { ok: false, error: String(extraction.reason) },
  });
}
