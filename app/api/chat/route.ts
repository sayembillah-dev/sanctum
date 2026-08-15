import { chat, summarizeConversation } from "@/lib/agent";
import { markRecallUsed } from "@/lib/graph";

export async function POST(req: Request) {
  const { messages } = await req.json();
  if (!Array.isArray(messages) || !messages.length) {
    return Response.json({ error: "messages required" }, { status: 400 });
  }

  const { stream, recalled, recalledNames } = await chat(messages);
  const encoder = new TextEncoder();
  let reply = "";

  return new Response(
    new ReadableStream({
      async start(controller) {
        try {
          for await (const chunk of stream) {
            const delta = chunk.choices[0]?.delta?.content;
            if (delta) {
              reply += delta;
              controller.enqueue(encoder.encode(delta));
            }
          }
        } finally {
          controller.close();
          // 🌱 Growth bookkeeping — fire-and-forget, never delays the reply:
          // recalled nodes the reply actually cited get their usage count bumped
          const used = recalled.filter((id) => {
            const name = recalledNames[id];
            return name && reply.toLowerCase().includes(name.toLowerCase());
          });
          if (used.length) markRecallUsed(used).catch(() => {});
          // every 12 messages, crystallize the recent stretch into a digest node
          if (messages.length >= 12 && messages.length % 12 === 0) {
            summarizeConversation(messages.slice(-16))
              .then((r) => console.log("🌙 digest:", JSON.stringify(r)))
              .catch((e) => console.error("🌙 digest failed:", e));
          }
        }
      },
    }),
    {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        // Which neurons fired for this reply — the graph view pulses these
        "X-Recalled-Nodes": JSON.stringify(recalled),
      },
    }
  );
}
