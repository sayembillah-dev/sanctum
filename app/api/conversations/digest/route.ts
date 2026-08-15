import { summarizeConversation } from "@/lib/agent";

export const maxDuration = 60;

/** POST /api/conversations/digest — explicit "session ended" (fired by clear-chat):
 *  crystallize the conversation into a graph-visible digest node. */
export async function POST(req: Request) {
  const { messages } = await req.json();
  if (!Array.isArray(messages)) {
    return Response.json({ error: "messages required" }, { status: 400 });
  }
  return Response.json(await summarizeConversation(messages));
}
