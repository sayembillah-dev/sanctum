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

          // If the model called the tool INSTEAD of replying (empty content),
          // persist FIRST so the phase-2 tool results are truthful (Hermes:
          // tool errors are built for model self-correction — a failed save
          // the model believes succeeded is a silently lost memory).
          if (!reply.trim() && calls.length) {
            const results: string[] = [];
            for (const c of calls) {
              if (c.name !== "remember") {
                results.push(`Unknown tool '${c.name}'.`);
                continue;
              }
              try {
                const r = await applyRemembered(lastUser, c.arguments);
                console.log("🧠 remember:", JSON.stringify(r));
                results.push(
                  r.ok
                    ? "✓ Saved to long-term memory."
                    : `✗ Memory save failed: ${r.error}. Fix the arguments and retry once, or skip saving.`
                );
              } catch (e) {
                console.error("🧠 remember failed:", e);
                results.push(
                  `✗ Memory save failed: ${
                    e instanceof Error ? e.message : String(e)
                  }. Fix the arguments and retry once, or skip saving.`
                );
              }
            }
            // One-shot retry: re-attach the remember tool only when a save
            // failed. No phase 3 exists, so this cannot recurse.
            const anyFail = results.some((r) => r.startsWith("✗"));
            const followup = await continueChat(requestMessages, calls, results, anyFail);
            const retryCalls: Record<number, { id: string; name: string; arguments: string }> = {};
            for await (const chunk of followup) {
              const delta = chunk.choices[0]?.delta;
              const c = delta?.content;
              if (c) {
                reply += c;
                controller.enqueue(encoder.encode(c));
              }
              if (anyFail) {
                for (const d of delta?.tool_calls ?? []) {
                  const slot = (retryCalls[d.index] ??= { id: "", name: "", arguments: "" });
                  if (d.id) slot.id = d.id;
                  if (d.function?.name) slot.name += d.function.name;
                  if (d.function?.arguments) slot.arguments += d.function.arguments;
                }
              }
            }
            // Retry saves persist fire-and-forget — the loop ends here.
            if (anyFail) {
              const retries = Object.keys(retryCalls)
                .map(Number)
                .sort((a, b) => a - b)
                .map((i) => retryCalls[i])
                .filter((c) => c.name === "remember");
              for (const c of retries) {
                applyRemembered(lastUser, c.arguments)
                  .then((r) => console.log("🧠 remember (retry):", JSON.stringify(r)))
                  .catch((e) => console.error("🧠 remember (retry) failed:", e));
              }
            }
          } else {
            // Fast path: the reply already streamed — fire-and-forget, the
            // reply NEVER waits for the write.
            for (const c of calls.filter((c) => c.name === "remember")) {
              applyRemembered(lastUser, c.arguments)
                .then((r) => console.log("🧠 remember:", JSON.stringify(r)))
                .catch((e) => console.error("🧠 remember failed:", e));
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
