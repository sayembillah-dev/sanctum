import { after } from "next/server";
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
  previousSession,
  markSessionSwept,
} from "@/lib/graph";

// Digest cadence: every 12 persisted messages (= 6 user⇄assistant exchanges).
// Sourced from the DB now — client retries or clear-chat can't shift or
// double-fire it, and the digest stretch comes from the server-side transcript.
const DIGEST_EVERY = 12;

/** Post-response work with a delivery guarantee. after() keeps a serverless
 *  function alive until the callback settles — a bare fire-and-forget promise
 *  can be frozen mid-write the moment the stream closes (a silently lost
 *  memory). Falls back to plain fire-and-forget outside a request context. */
function defer(fn: () => Promise<void>) {
  try {
    after(fn);
  } catch {
    void fn();
  }
}

/** Queued remember-save with ONE retry: by the time these drain, the reply has
 *  already streamed, so model self-correction is impossible — delivery is the
 *  only guarantee left. Dropped edges are logged loudly (they're lost facts). */
async function saveRemembered(message: string, argsJson: string, tag: string) {
  let r = await applyRemembered(message, argsJson).catch((e) => ({
    ok: false as const,
    error: e instanceof Error ? e.message : String(e),
  }));
  if (!r.ok) {
    await new Promise((s) => setTimeout(s, 500));
    r = await applyRemembered(message, argsJson).catch((e) => ({
      ok: false as const,
      error: e instanceof Error ? e.message : String(e),
    }));
  }
  if (r.ok) {
    console.log(`🧠 remember${tag}:`, JSON.stringify(r));
    if (r.edgesDropped.length) {
      console.warn(`🧠 remember${tag} dropped edge(s):`, JSON.stringify(r.edgesDropped));
    }
  } else {
    console.error(`🧠 remember${tag} failed (after retry):`, r.error);
  }
}

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
  // 18 = MAX_CHAT_HISTORY in agent.ts (the model window) — fetching more was discarded unread.
  const messages = await recentChatMessages(sessionId, 18);

  // 🏷️ X5 stage 1: the very first user message names the session INSTANTLY
  // (deterministic slice, before any model call) — even a failed first reply
  // leaves a named conversation. The LLM upgrade arrives later (see finally).
  // First-message title is known locally — no re-fetch. Otherwise the title
  // lookup rides in parallel with chat() instead of blocking it.
  let titleLocal: { title: string | null; title_source: string } | null = null;
  if (messages.length === 1) {
    await setSessionTitle(sessionId, message.slice(0, 48), "derived").catch(() => {});
    titleLocal = { title: message.slice(0, 48), title_source: "derived" };
  }
  const [{ stream, recalled, recalledNames, requestMessages }, titleInfo] = await Promise.all([
    chat(messages),
    titleLocal ? Promise.resolve(titleLocal) : getSessionTitleInfo(sessionId).catch(() => null),
  ]);
  const encoder = new TextEncoder();
  let reply = "";
  // Tool-call fragments stream in piecemeal, addressed by index — accumulate
  // them here. They are NEVER enqueued: the user sees only the reply text.
  const toolCalls: Record<number, { id: string; name: string; arguments: string }> = {};
  // Post-stream write queue: drained IN ORDER by a single after() callback in
  // the stream's finally block — writes can't be frozen mid-flight, and the
  // digest cadence always reads a fully persisted transcript.
  const postWork: (() => Promise<void>)[] = [];

  // 🌙 Session-start healing: the PREVIOUS session may have ended below the
  // 12-msg digest cadence without a clear-chat sweep (tab closed, wandered
  // off) — every fact the remember tool skipped there is stranded in its
  // transcript. Sweep the unswept tail now (queued, never delays this reply).
  if (messages.length === 1) {
    const prev = await previousSession(sessionId).catch(() => null);
    if (prev && prev.msgs > prev.swept) {
      postWork.push(async () => {
        const tail = await recentChatMessages(prev.id, Math.min(16, prev.msgs - prev.swept + 4));
        const r = await extractFromStretch(tail);
        console.log("🌙 session-start sweep:", JSON.stringify(r));
        await markSessionSwept(prev.id, prev.msgs);
      });
    }
  }

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
          // extra LLM calls. Saves are queued (postWork) for guaranteed
          // post-response delivery: the reply NEVER waits for the write.
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
            let anyDropped = false;
            for (const c of calls) {
              if (c.name !== "remember") {
                results.push(`Unknown tool '${c.name}'.`);
                continue;
              }
              try {
                const r = await applyRemembered(message, c.arguments);
                console.log("🧠 remember:", JSON.stringify(r));
                let msg = r.ok
                  ? r.unchanged
                    ? "✓ Already known — this exact memory exists, nothing changed. Don't save it again in future replies."
                    : "✓ Saved to long-term memory."
                  : `✗ Memory save failed: ${r.error}. Fix the arguments and retry once, or skip saving.`;
                // A dropped edge is a fact about to be lost — tell the model
                // exactly what's missing so the retry can save it for real.
                if (r.ok && r.edgesDropped.length) {
                  anyDropped = true;
                  msg += ` ⚠️ ${r.edgesDropped.length} edge(s) dropped — unknown node(s): ${r.edgesDropped
                    .map((d) => `${d.src} -${d.type}-> ${d.dst}`)
                    .join(
                      "; "
                    )}. Declare the missing endpoint(s) in nodes[] and call remember once more.`;
                }
                results.push(msg);
              } catch (e) {
                console.error("🧠 remember failed:", e);
                results.push(
                  `✗ Memory save failed: ${
                    e instanceof Error ? e.message : String(e)
                  }. Fix the arguments and retry once, or skip saving.`
                );
              }
            }
            // One-shot retry: re-attach the remember tool when a save failed
            // OR edges were dropped. No phase 3 exists, so this cannot recurse.
            const anyFail = results.some((r) => r.startsWith("✗")) || anyDropped;
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
            // Retry saves ride the post-stream queue — the loop ends here.
            if (anyFail) {
              const retries = Object.keys(retryCalls)
                .map(Number)
                .sort((a, b) => a - b)
                .map((i) => retryCalls[i])
                .filter((c) => c.name === "remember");
              for (const c of retries) {
                postWork.push(() => saveRemembered(message, c.arguments, " (retry)"));
              }
            }
          } else {
            // Fast path: the reply already streamed — queue the saves; the
            // reply NEVER waits for the write (after() delivery + one retry).
            for (const c of calls.filter((c) => c.name === "remember")) {
              postWork.push(() => saveRemembered(message, c.arguments, ""));
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
          // ALL post-response work runs in ONE after() callback, in order:
          // transcript first (the cadence reads it), then queued memory
          // writes, then growth bookkeeping and the digest-cadence safety net.
          defer(async () => {
            // Persist the assistant turn (even a partial one) — history, cadence
            // and digests all read from the DB transcript now.
            await appendChatMessage(sessionId, "assistant", reply).catch(() => {});
            for (const w of postWork) {
              await w().catch((e) => console.error("🧠 post-write failed:", e));
            }
            // 🌱 Growth bookkeeping: recalled nodes the reply actually cited
            // get their usage count bumped.
            const used = recalled.filter((id) => {
              const name = recalledNames[id];
              return name && reply.toLowerCase().includes(name.toLowerCase());
            });
            if (used.length) await markRecallUsed(used).catch(() => {});
            // Every 12 persisted messages: crystallize the recent stretch into a
            // digest node + safety-net extraction over it (catches lasting facts
            // the in-reply remember tool didn't fire on).
            const count = await sessionMessageCount(sessionId).catch(() => 0);
            // 🏷️ X5 stage 2: once the session has substance (6 msgs, then each
            // digest boundary while still untitled-by-LLM), upgrade the title.
            // Provenance guard: never overwrite an 'llm' or 'user' title.
            if (count === 6 || (count > 6 && count % DIGEST_EVERY === 0)) {
              try {
                const info = await getSessionTitleInfo(sessionId);
                if (info && info.title_source === "derived") {
                  const t = await titleForSession(await recentChatMessages(sessionId, 8));
                  if (t) {
                    await setSessionTitle(sessionId, t, "llm");
                    console.log("🏷️ title upgraded:", t);
                  }
                }
              } catch {
                /* best-effort title */
              }
            }
            if (count >= DIGEST_EVERY && count % DIGEST_EVERY === 0) {
              const stretch = await recentChatMessages(sessionId, 16).catch(() => []);
              if (stretch.length) {
                const [d, x] = await Promise.allSettled([
                  summarizeConversation(stretch),
                  extractFromStretch(stretch),
                ]);
                if (d.status === "fulfilled") console.log("🌙 digest:", JSON.stringify(d.value));
                else console.error("🌙 digest failed:", d.reason);
                if (x.status === "fulfilled") console.log("🌙 digest-extract:", JSON.stringify(x.value));
                else console.error("🌙 digest-extract failed:", x.reason);
                await markSessionSwept(sessionId, count).catch(() => {});
              }
            }
          });
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
