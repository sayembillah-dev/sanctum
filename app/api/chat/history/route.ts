import { currentSessionId, getSessionTitleInfo, recentChatMessages } from "@/lib/graph";

export const dynamic = "force-dynamic"; // never cache — the thread is live

/** GET /api/chat/history — rehydrate the current session's thread on page load.
 *  Conversation persistence: a refresh no longer wipes the chat.
 *  Also returns the session title (X5 two-stage titles). */
export async function GET() {
  const sessionId = await currentSessionId();
  const [messages, info] = await Promise.all([
    recentChatMessages(sessionId, 100),
    getSessionTitleInfo(sessionId).catch(() => null),
  ]);
  return Response.json({ messages, title: info?.title ?? null });
}
