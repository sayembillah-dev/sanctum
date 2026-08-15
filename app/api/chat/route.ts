import {
  chat,
  continueChat,
  applyRemembered,
  summarizeConversation,
  extractFromStretch,
} from "@/lib/agent";
import { markRecallUsed } from "@/lib/graph";

export async function POST(req: Request) {
  const { messages } = await req.json();
  if (!Array.isArray(messages) || !messages.length) {
    return Response.json({ error: "messages required" }, { status: 400 });
  }

  const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
  const { stream, recalled, recalledNames, requestMessages } = await chat(messages);
  const encoder = new TextEncoder();
  let reply = "";
  // Tool-call fragments stream in piecemeal, addressed by index — accumulate
  // them here. They are NEVER enqueued: the user sees only the reply text.
  const toolCalls: Record<number, { id: string; name: string; arguments: string }> = {};

  return new Response(
    new ReadableStream({
      async start(controller) {
        try {
          for await (const chunk of stream) {
            const delta = chunk.choices[0]?.delta;
            if (delta?.content) {
              reply += delta.content;
              controller.enqueue(encoder.encode(delta.content));
            }
            for (const d of delta?.tool_calls ?? []) {
              const slot = (toolCalls[d.index] ??= { id: "", name: "", arguments: "" });
              if (d.id) slot.id = d.id;
              if (d.function?.name) slot.name += d.function.name;
              if (d.function?.arguments) slot.arguments += d.function.arguments;
            }
          }

          // 🧠 MemGPT loop — the model decided mid-reply what's worth remembering.
          // The gating cost rode on the reply call, so persistence is free of
          // extra LLM calls. Fire-and-forget: the reply NEVER waits for the write.
          const calls = Object.keys(toolCalls)
            .map(Number)
            .sort((a, b) => a - b)
            .map((i) => toolCalls[i]);
          for (const c of calls.filter((c) => c.name === "remember")) {
            applyRemembered(lastUser, c.arguments)
              .then((r) => console.log("🧠 remember:", JSON.stringify(r)))
              .catch((e) => console.error("🧠 remember failed:", e));
          }

          // If the model called the tool INSTEAD of replying (empty content),
          // close the loop: feed back the tool result and stream the real reply.
          if (!reply.trim() && calls.length) {
            const followup = await continueChat(requestMessages, calls);
            for await (const chunk of followup) {
              const delta = chunk.choices[0]?.delta?.content;
              if (delta) {
                reply += delta;
                controller.enqueue(encoder.encode(delta));
              }
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
          // every 12 messages: crystallize the recent stretch into a digest node,
          // and run the safety-net extraction over it — catches lasting facts the
          // in-reply remember tool didn't fire on (amortized ~12× cheaper than
          // the old per-message silent extraction).
          if (messages.length >= 12 && messages.length % 12 === 0) {
            const stretch = messages.slice(-16);
            summarizeConversation(stretch)
              .then((r) => console.log("🌙 digest:", JSON.stringify(r)))
              .catch((e) => console.error("🌙 digest failed:", e));
            extractFromStretch(stretch)
              .then((r) => console.log("🌙 digest-extract:", JSON.stringify(r)))
              .catch((e) => console.error("🌙 digest-extract failed:", e));
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
