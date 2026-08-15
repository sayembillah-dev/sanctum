import {
  chat,
  continueChat,
  applyRemembered,
  summarizeConversation,
  extractFromStretch,
  titleForSession,
} from "@/lib/agent";
import { requireUser } from "@/lib/auth";
import {
  markRecallUsed,
  currentSessionId,
  appendChatMessage,
  recentChatMessages,
  sessionMessageCount,
  setSessionTitle,
  getSessionTitleInfo,
} from "@/lib/graph";

// Digest cadence: every 12 persisted messages (= 6 user⇄assistant exchanges).
// Sourced from the DB now — client retries or clear-chat can't shift or
// double-fire it, and the digest stretch comes from the server-side transcript.
const DIGEST_EVERY = 12;

export async function POST(req: Request) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });

  let body: { message?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) {
    return Response.json({ error: "message required" }, { status: 400 });
  }

  // Server-side conversation state: persist the user turn, then build context
  // from the DB — the client no longer ships the whole thread with each request.
  const sessionId = await currentSessionId();
  await appendChatMessage(sessionId, "user", message);
  const messages = await recentChatMessages(sessionId, 40);

  // 🏷️ X5 stage 1: the very first user message names the session INSTANTLY
  // (deterministic slice, before any model call) — even a failed first reply
  // leaves a named conversation. The LLM upgrade arrives later (see finally).
  if (messages.length === 1) {
    await setSessionTitle(sessionId, message.slice(0, 48), "derived").catch(() => {});
  }
  const titleInfo = await getSessionTitleInfo(sessionId).catch(() => null);

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
                const r = await applyRemembered(message, c.arguments);
                console.log("🧠 remember:", JSON.stringify(r));
                results.push(
                  r.ok
                    ? r.unchanged
                      ? "✓ Already known — this exact memory exists, nothing changed. Don't save it again in future replies."
                      : "✓ Saved to long-term memory."
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
                applyRemembered(message, c.arguments)
                  .then((r) => console.log("🧠 remember (retry):", JSON.stringify(r)))
                  .catch((e) => console.error("🧠 remember (retry) failed:", e));
              }
            }
          } else {
            // Fast path: the reply already streamed — fire-and-forget, the
            // reply NEVER waits for the write.
            for (const c of calls.filter((c) => c.name === "remember")) {
              applyRemembered(message, c.arguments)
                .then((r) => console.log("🧠 remember:", JSON.stringify(r)))
                .catch((e) => console.error("🧠 remember failed:", e));
            }
          }
        } catch (e) {
          // A mid-stream failure used to surface as a silently truncated reply.
          // Keep whatever streamed, tell the user it broke, persist the partial.
          console.error("chat stream failed:", e);
          try {
            controller.enqueue(encoder.encode("\n\n⚠️ (connection dropped mid-reply — try sending again)"));
          } catch {
            /* stream already closed */
          }
        } finally {
          controller.close();
          // Persist the assistant turn (even a partial one) — history, cadence
          // and digests all read from the DB transcript now.
          await appendChatMessage(sessionId, "assistant", reply).catch(() => {});
          // 🌱 Growth bookkeeping — fire-and-forget, never delays the reply:
          // recalled nodes the reply actually cited get their usage count bumped
          const used = recalled.filter((id) => {
            const name = recalledNames[id];
            return name && reply.toLowerCase().includes(name.toLowerCase());
          });
          if (used.length) markRecallUsed(used).catch(() => {});
          // Every 12 persisted messages: crystallize the recent stretch into a
          // digest node + safety-net extraction over it (catches lasting facts
          // the in-reply remember tool didn't fire on).
          const count = await sessionMessageCount(sessionId).catch(() => 0);
          // 🏷️ X5 stage 2: once the session has substance (6 msgs, then each
          // digest boundary while still untitled-by-LLM), upgrade the title.
          // Provenance guard: never overwrite an 'llm' or 'user' title.
          if (count === 6 || (count > 6 && count % DIGEST_EVERY === 0)) {
            (async () => {
              const info = await getSessionTitleInfo(sessionId);
              if (!info || info.title_source !== "derived") return;
              const t = await titleForSession(await recentChatMessages(sessionId, 8));
              if (t) {
                await setSessionTitle(sessionId, t, "llm");
                console.log("🏷️ title upgraded:", t);
              }
            })().catch(() => {});
          }
          if (count >= DIGEST_EVERY && count % DIGEST_EVERY === 0) {
            recentChatMessages(sessionId, 16)
              .then((stretch) => {
                summarizeConversation(stretch)
                  .then((r) => console.log("🌙 digest:", JSON.stringify(r)))
                  .catch((e) => console.error("🌙 digest failed:", e));
                extractFromStretch(stretch)
                  .then((r) => console.log("🌙 digest-extract:", JSON.stringify(r)))
                  .catch((e) => console.error("🌙 digest-extract failed:", e));
              })
              .catch(() => {});
          }
        }
      },
    }),
    {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        // Which neurons fired for this reply — the graph view pulses these
        "X-Recalled-Nodes": JSON.stringify(recalled),
        // 🏷️ current session title (uri-encoded — headers are latin-1 only)
        ...(titleInfo?.title ? { "X-Session-Title": encodeURIComponent(titleInfo.title) } : {}),
      },
    }
  );
}
