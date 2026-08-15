import { after } from "next/server";
import { summarizeConversation, extractFromStretch } from "@/lib/agent";
import {
  currentSessionId,
  recentChatMessages,
  rotateSession,
  sessionMessageCount,
  markSessionSwept,
} from "@/lib/graph";
import { requireUser } from "@/lib/auth";

export const maxDuration = 60;

/** POST /api/conversations/digest — explicit "session ended" (fired by clear-chat).
 *  ROTATE FIRST: clear-chat is instant and reload-safe (a reload mid-sweep must
 *  never resurrect the old thread). The crystallization — digest node + fact
 *  extraction over the SERVER-SIDE transcript — runs in after() behind it.
 *  Session end is the LAST chance to sweep facts: extraction catches whatever
 *  the remember tool skipped, and swept_count is marked so session-start
 *  healing doesn't redo the work. */
export async function POST() {
  const user = await requireUser();
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });
  const sessionId = await currentSessionId();
  const total = await sessionMessageCount(sessionId).catch(() => 0);
  await rotateSession();
  after(async () => {
    const stretch = await recentChatMessages(sessionId, 40);
    const [digest, extraction] = await Promise.allSettled([
      summarizeConversation(stretch), // self-rejects when < 4 substantive
      extractFromStretch(stretch), // self-rejects on empty stretch
    ]);
    console.log("🌙 clear-chat digest:", JSON.stringify(digest.status === "fulfilled" ? digest.value : digest.reason));
    console.log("🌙 clear-chat extract:", JSON.stringify(extraction.status === "fulfilled" ? extraction.value : extraction.reason));
    await markSessionSwept(sessionId, total).catch(() => {});
  });
  return Response.json({ ok: true, swept: "queued" });
}
