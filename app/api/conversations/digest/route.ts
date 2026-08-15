import { summarizeConversation } from "@/lib/agent";
import { currentSessionId, recentChatMessages, rotateSession } from "@/lib/graph";
import { requireUser } from "@/lib/auth";

export const maxDuration = 60;

/** POST /api/conversations/digest — explicit "session ended" (fired by clear-chat):
 *  crystallize the session into a digest node from the SERVER-SIDE transcript
 *  (the client no longer ships messages), then rotate to a fresh session. */
export async function POST() {
  const user = await requireUser();
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });
  const sessionId = await currentSessionId();
  const stretch = await recentChatMessages(sessionId, 40);
  const result = await summarizeConversation(stretch); // self-rejects when < 4 substantive
  await rotateSession();
  return Response.json(result);
}
