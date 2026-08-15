import { currentSessionId, recentChatMessages } from "@/lib/graph";

export const dynamic = "force-dynamic"; // never cache — the thread is live

/** GET /api/chat/history — rehydrate the current session's thread on page load.
 *  Conversation persistence: a refresh no longer wipes the chat. */
export async function GET() {
  const sessionId = await currentSessionId();
  const messages = await recentChatMessages(sessionId, 100);
  return Response.json({ messages });
}
