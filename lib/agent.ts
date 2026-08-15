import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ai, withRetry, CHAT_MODEL } from "./ai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import {
  persistExtraction,
  searchNodes,
  nodesNamedIn,
  nodeEdges,
  recentNodes,
  findNode,
  updateNode,
  closeEdges,
  forgetNode,
  ensureProfile,
  markRecalled,
  openLoops,
  createDigest,
  dupeCandidates,
  mergeNodes,
  staleNodes,
  recentNegativeFeedback,
  PROFILE_NAME,
} from "./graph";
import { scanMemoryContent } from "./guard";

// The brain is markdown — code enforces invariants, markdown guides judgment.
// Cached by mtime: editing a brain file is picked up on the next call, but we no
// longer read disk on every call (extraction alone read two files per message).
const brainCache = new Map<string, { mtimeMs: number; content: string }>();
async function brain(file: string): Promise<string> {
  const p = path.join(process.cwd(), "brain", file);
  const { mtimeMs } = await fs.stat(p);
  const hit = brainCache.get(file);
  if (hit && hit.mtimeMs === mtimeMs) return hit.content;
  const content = await fs.readFile(p, "utf8");
  brainCache.set(file, { mtimeMs, content });
  return content;
}

const localToday = () => new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD, local TZ (not UTC!)

const Extraction = z.object({
  nodes: z.array(
    z.object({
      type: z.string(),
      name: z.string(),
      attrs: z.record(z.any()).default({}),
    })
  ),
  edges: z.array(
    z.object({
      src: z.string(),
      dst: z.string(),
      type: z.string(),
      said_on: z.string().optional(),
      due_by: z.string().optional(),
    })
  ),
  updates: z
    .array(
      z.object({
        node: z.string(), // EXACT existing node name
        set_attrs: z.record(z.any()).optional(), // merge/overwrite attrs
        rename: z.string().optional(), // corrected/new name
        close_edges: z.array(z.string()).default([]), // edge types no longer true
        forget: z.boolean().default(false), // user explicitly asked to forget
      })
    )
    .default([]),
});

const Digest = z.object({
  summary: z.string(),
  mentioned: z.array(z.string()).default([]),
});

const Consolidation = z.object({
  profile_updates: z.record(z.any()).default({}),
  merges: z.array(z.object({ keep: z.string(), drop: z.string() })).default([]),
  insight: z.string().default(""),
});

// ── The remember tool (MemGPT/Letta pattern) ─────────────────────────────────
// The chat model itself decides mid-reply what's worth saving — the gating cost
// rides on the reply call, so memory writes cost ZERO extra LLM calls. The rules
// below are ported from brain/extract.md; the digest-cadence extraction
// (extractFromStretch, fired every ~12 messages) is the safety net for misses.
const REMEMBER_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "remember",
    description: [
      "Save lasting facts to long-term memory. Call this WHILE writing your normal reply —",
      "the user never sees the call, and you must ALWAYS still write your reply text.",
      "",
      "WHEN to call: the user reveals something with a shelf life — people, orgs, projects,",
      "places, tasks/commitments, preferences, decisions, plans, corrections to older facts,",
      "or anything about THE USER themselves (habits, goals, style feedback, personal details).",
      "WHEN NOT to call: small talk, questions, one-off jokes, transient chatter.",
      "",
      "RULES:",
      "- Reuse the EXACT name of existing memory nodes (see 'Recalled memories' and the profile in context) — never mint near-duplicates",
      "- No orphan nodes: link every new node with an edge to something known (or to another new node)",
      "- Fewer, deeper nodes — hard cap 3 new nodes per call; minute details belong in attrs, not as nodes",
      "- Facts about the user go on their profile node via updates.set_attrs with flat dot-keys (e.g. 'habit.running', 'style.length') — never as separate nodes",
      "- Corrected/superseded facts → an updates entry on the EXACT existing node (set_attrs / rename / close_edges)",
      "- Forget ONLY on an explicit user request: updates entry with forget=true",
      "- Resolve relative dates ('this Friday') to ISO dates using today's date",
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        nodes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              type: { type: "string" },
              name: { type: "string" },
              attrs: { type: "object", additionalProperties: true },
            },
            required: ["type", "name"],
          },
        },
        edges: {
          type: "array",
          items: {
            type: "object",
            properties: {
              src: { type: "string" },
              dst: { type: "string" },
              type: { type: "string" },
              said_on: { type: "string" },
              due_by: { type: "string" },
            },
            required: ["src", "dst", "type"],
          },
        },
        updates: {
          type: "array",
          items: {
            type: "object",
            properties: {
              node: { type: "string" },
              set_attrs: { type: "object", additionalProperties: true },
              rename: { type: "string" },
              close_edges: { type: "array", items: { type: "string" } },
              forget: { type: "boolean" },
            },
            required: ["node"],
          },
        },
      },
      required: ["nodes", "edges"],
    },
  },
};

/** JSON-mode chat call: temperature 0 (deterministic — fewer malformed outputs)
 *  plus one retry with a nudge when parsing still fails. Returns null on failure. */
async function chatJson(system: string, user: string): Promise<unknown | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await withRetry(
      () =>
        ai().chat.completions.create({
          model: CHAT_MODEL,
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: system },
            {
              role: "user",
              content:
                attempt === 0
                  ? user
                  : user + "\n\n(Previous reply was not valid JSON — output ONLY the JSON object.)",
            },
          ],
        }),
      { label: "chatJson" }
    );
    try {
      return JSON.parse(res.choices[0]?.message?.content ?? "");
    } catch {
      // fall through to the retry
    }
  }
  return null;
}

export type ChatMessage = { role: "user" | "assistant"; content: string };

// ── M6: recall query rewrite (ported from Hermes plugins/memory/query_rewrite.py) ──
// Follow-ups like "what did he say about it?" are useless as vector-search
// queries on their own. One aux temp-0 call rewrites the recent turns into ONE
// standalone search question; strict validation (question-word start, length,
// no instruction-leak) with silent fallback to the raw 3-turn concat.
const QUESTION_START =
  /^(who|what|when|where|why|how|which|whose|whom|did|does|do|is|are|was|were|has|have|had|can|could|should|would|tell|show|list)\b/i;

async function rewriteRecallQuery(messages: ChatMessage[]): Promise<string | null> {
  const transcript = messages
    .slice(-6)
    .map((m) => `${m.role === "user" ? "User" : "Sanctum"}: ${m.content.slice(0, 500)}`)
    .join("\n")
    .slice(0, 3000);
  if (!transcript) return null;
  try {
    const res = await withRetry(
      () =>
        ai().chat.completions.create({
          model: CHAT_MODEL,
          temperature: 0,
          max_tokens: 100,
          messages: [
            {
              role: "system",
              content: [
                "Rewrite the user's LATEST message into ONE standalone search question for a personal memory database.",
                "Resolve pronouns and references using the conversation (e.g. 'he' → the person's name).",
                "If the latest message is already standalone, keep it as-is (as a question).",
                "Output ONLY the question — it must start with a question word (who/what/when/where/why/how/did/does/is/are/was/were…).",
              ].join("\n"),
            },
            { role: "user", content: transcript },
          ],
        }),
      { attempts: 2, label: "query-rewrite" }
    );
    const q = res.choices[0]?.message?.content?.trim().replace(/^["'`]+|["'`]+$/g, "");
    if (!q || q.length < 8 || q.length > 300) return null;
    if (!QUESTION_START.test(q)) return null; // must be a real question
    if (/\b(ignore|system prompt|your instructions|forget everything)\b/i.test(q)) return null; // leak guard
    return q;
  } catch {
    return null; // rewrite is best-effort — never breaks the turn
  }
}

// Retrieval guards: pgvector ALWAYS returns top-N, even when every hit is irrelevant —
// so without a similarity floor, unrelated nodes pollute the prompt (and waste tokens).
const MIN_RECALL_SCORE = 0.4; // cosine similarity floor for "this memory is actually relevant"
const MAX_RECALL_NODES = 8; // cap tokens
const MAX_RECALL_EDGES = 16; // cap 1-hop neighborhood expansion
const SALIENCE_WEIGHT = 0.08; // how much use boosts rank: ×(1 + ln(1+mentions)·w) — 30 mentions ≈ +27%
const MAX_CHAT_HISTORY = 18; // messages sent to the model — digests cover the older stretches
const RECENCY_WEIGHT = 0.15; // recently-surfaced memories get a small decaying boost (half-life ≈ 10 days)
const daysSince = (d: Date | null | undefined) =>
  d ? (Date.now() - new Date(d).getTime()) / 864e5 : 365; // never recalled → treated as old

/**
 * Build memory context for a message: literal name mentions + thresholded semantic
 * search → salience × recency rerank → capped 1-hop neighborhood. The pinned profile
 * node is excluded here (it's always in context separately). Surfaced nodes get
 * last_recalled_at stamped.
 */
async function buildContext(
  query: string,
  excludeId?: string
): Promise<{ text: string; ids: string[]; names: Record<string, string> }> {
  if (!query.trim()) return { text: "(no query)", ids: [], names: {} };
  // Literal name mentions + vector search run together. A name in the query is a
  // stronger signal than cosine — those nodes bypass the similarity floor.
  const [hits, named] = await Promise.all([searchNodes(query, 12), nodesNamedIn(query)]);
  const byId = new Map<string, { id: string; type: string; name: string; attrs: unknown; score: number; mention_count: number; last_recalled_at: Date | null }>();
  for (const n of named) if (n.id !== excludeId) byId.set(n.id, { ...n, score: 1 });
  for (const n of hits) {
    if (n.id === excludeId || n.score < MIN_RECALL_SCORE) continue;
    if (!byId.has(n.id)) byId.set(n.id, n);
  }
  const nodes = [...byId.values()]
    // 🌱 salience × recency rerank: used memories rise, recently-surfaced ones get
    // a small decaying boost, untouched trivia sinks
    .map((n) => ({
      ...n,
      blended:
        n.score *
        (1 + Math.log1p(n.mention_count ?? 1) * SALIENCE_WEIGHT) *
        (1 + RECENCY_WEIGHT * Math.exp(-daysSince(n.last_recalled_at) / 14.4)),
    }))
    .sort((a, b) => b.blended - a.blended)
    .slice(0, MAX_RECALL_NODES);
  if (!nodes.length) {
    return { text: "(nothing in memory is relevant to this message)", ids: [], names: {} };
  }
  const ids = nodes.map((n) => n.id);
  const edges = await nodeEdges(ids, MAX_RECALL_EDGES); // newest-first, capped in SQL
  markRecalled(ids).catch(() => {}); // attention signal — fire-and-forget
  return {
    ids,
    names: Object.fromEntries(nodes.map((n) => [n.id, n.name])),
    text: [
      "Nodes (entities from memory):",
      ...nodes.map((n) => `- ${n.name} [${n.type}] ${JSON.stringify(n.attrs)}`),
      "Edges (relationships):",
      ...edges.map(
        (e) => `- ${e.src} —${e.type}→ ${e.dst}` + (e.said_on ? ` (said ${e.said_on})` : "")
      ),
    ].join("\n"),
  };
}

export async function runExtraction(text: string) {
  // The extractor must SEE the current graph — otherwise it mints duplicates
  // and can't link new facts to what it already knows. The profile node is always
  // included so user-facts have somewhere to land.
  const [extractMd, typesMd, relevant, recent, profile] = await Promise.all([
    brain("extract.md"),
    brain("types.md"),
    searchNodes(text, 20),
    recentNodes(20),
    ensureProfile(),
  ]);

  const known = new Map<string, { id: string; type: string; name: string }>();
  for (const n of [...relevant, ...recent]) if (!known.has(n.id)) known.set(n.id, n);
  if (!known.has(profile.id)) known.set(profile.id, profile);
  const knownList =
    [...known.values()].map((n) => `- ${n.name} [${n.type}]`).join("\n") ||
    "(empty — this is the first memory)";

  const parsedJson = await chatJson(
    `${extractMd}\n\n# Current type registry\n${typesMd}\n\n# Existing memory nodes (reuse & link)\n${knownList}\n\n# The user\nThe person speaking IS "${profile.name}" — their profile node exists in the list above. Facts about THEM route there via updates (see "user model" rules).\n\nToday's date: ${localToday()}`,
    text
  );
  if (parsedJson === null) {
    return { ok: false as const, error: "model did not return valid JSON (after retry)" };
  }

  const parsed = Extraction.safeParse(parsedJson);
  if (!parsed.success) {
    return { ok: false as const, error: "schema validation failed", issues: parsed.error.issues };
  }

  // --- Persist to the memory graph + apply revision entries (shared helper) ---
  const r = await applyExtraction(text, parsed.data, [...known.values()]);
  return {
    ok: true as const,
    dumpId: r.dumpId,
    nodes: { created: r.created, reused: r.reused },
    edgesCreated: r.edgesCreated,
    updated: r.updated,
    forgotten: r.forgotten,
  };
}

/** Persist a validated extraction atomically (nodes/edges via persistExtraction),
 *  then apply revision entries — update / supersede / forget. Shared by silent
 *  digest extraction (runExtraction) and tool-called remembers (applyRemembered). */
async function applyExtraction(
  sourceText: string,
  data: z.infer<typeof Extraction>,
  known: { id: string; type: string; name: string }[]
) {
  const { dumpId, created, reused, edgesCreated } = await persistExtraction(
    sourceText,
    data.nodes,
    data.edges,
    known
  );

  // --- Revision: update / supersede / forget existing memory ---
  const updated: string[] = [];
  const forgotten: string[] = [];
  for (const u of data.updates) {
    if (u.forget) {
      const f = await forgetNode(u.node);
      if (f) forgotten.push(f.name);
      continue;
    }
    // M7: skip content-free updates entries (no attrs, no rename, no edge
    // closures) — they used to trigger a full re-embed + 2 writes for nothing,
    // and they made no-op saves indistinguishable from real changes.
    const hasContent = Object.keys(u.set_attrs ?? {}).length > 0 || !!u.rename?.trim();
    if (!hasContent && !u.close_edges.length) continue;
    const up = await updateNode(u.node, { setAttrs: u.set_attrs, rename: u.rename });
    if (up) {
      updated.push(up.name);
      if (u.close_edges.length) await closeEdges(up.id, u.close_edges);
    }
  }
  return { dumpId, created, reused, edgesCreated, updated, forgotten };
}

/** Conversational chat: tool-called memory writes + grounded streamed reply.
 *  The reply call carries the `remember` tool — the model decides mid-reply what
 *  to save (zero extra LLM calls), and digest-cadence extraction is the safety
 *  net. The profile and open loops are ALWAYS in context — this is what makes
 *  Sanctum feel like it knows you better every time. */
/** Trivial-prompt gate, ported from Hermes `is_trivial_prompt`
 *  (memory_provider.py:84): bare acknowledgements and greetings carry no
 *  semantic signal, so recall is skipped entirely — no embedding call, no
 *  vector search, no DB round-trip. Anchored alternation + trailing-punctuation
 *  allowance, so "k8s" or "yolo" never match but "hi!" / "thanks :)" do. */
const TRIVIAL_PROMPT_RE =
  /^(yes|no|ok|okay|sure|thanks|thank you|y|n|yep|nope|yeah|nah|hi|hey|hello|yo|sup|continue|go ahead|do it|proceed|got it|cool|nice|great|done|next|lgtm|k)[\s!?.:;,"'‘’“”—–…()\[\]{}<>*&^%$#@!+=` ]*$/i;

function isTrivialPrompt(text: string): boolean {
  const s = (text ?? "").trim();
  if (!s || s.startsWith("/")) return true;
  return TRIVIAL_PROMPT_RE.test(s);
}

export async function chat(messages: ChatMessage[]) {
  const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";

  const profile = await ensureProfile();

  // Recall from the last few user turns, not just the latest — follow-ups like
  // "what did he say about it?" carry no entity names on their own.
  const rawRecallQuery =
    messages
      .filter((m) => m.role === "user")
      .slice(-3)
      .map((m) => m.content)
      .join("\n") || lastUser;

  const trivial = isTrivialPrompt(lastUser);
  if (trivial) console.log("🧠 recall skipped: trivial message");

  // M6: the rewrite call runs CONCURRENTLY with the other context fetches —
  // only buildContext depends on it, so it adds ~0 wall-clock latency.
  const rewriteP = trivial ? Promise.resolve(null) : rewriteRecallQuery(messages);

  const [chatMd, loops, profileEdges, rewritten] = await Promise.all([
    brain("chat.md"),
    openLoops(),
    nodeEdges([profile.id]),
    rewriteP,
  ]);

  const recallQuery = rewritten ?? rawRecallQuery;
  if (rewritten) console.log("🧠 recall query rewritten:", rewritten.slice(0, 120));

  const ctx = trivial
    ? { ids: [] as string[], names: {} as Record<string, string>, text: "" }
    : await buildContext(recallQuery, profile.id);

  const loopsText = loops.length
    ? loops
        .map((l) => `- ${l.name}${l.due ? ` (due ${l.due}${l.overdue ? " — overdue" : ""})` : " (no deadline)"}`)
        .join("\n")
    : "(none)";

  const system = `${chatMd}

Today's date: ${localToday()}

# Who you're talking to (always known — never recited)
${profile.name} [${profile.type}] ${JSON.stringify(profile.attrs).slice(0, 2000)}
${profileEdges.map((e) => `- ${e.src} —${e.type}→ ${e.dst}`).join("\n") || "(no relationships yet)"}

# Open loops (unresolved threads — follow up when natural)
${loopsText}

# Recalled memories
${ctx.text}`;

  // Windowed history: digests crystallize older stretches into the graph, so the
  // model only needs the recent tail — token cost stays bounded as sessions grow.
  const requestMessages: ChatCompletionMessageParam[] = [
    { role: "system", content: system },
    ...messages
      .slice(-MAX_CHAT_HISTORY)
      .map((m): ChatCompletionMessageParam => ({ role: m.role, content: m.content })),
  ];

  // 🧠 The `remember` tool rides on this very call — the reply stream may carry
  // tool_call deltas alongside (or instead of) content. route.ts accumulates and
  // persists them; requestMessages is returned so the tool loop can be closed.
  // R4: stream CREATION is retried (a 429 here used to kill the reply outright);
  // mid-stream drops are still handled by the route's error marker.
  const stream = await withRetry(
    () =>
      ai().chat.completions.create({
        model: CHAT_MODEL,
        stream: true,
        tools: [REMEMBER_TOOL],
        tool_choice: "auto",
        messages: requestMessages,
      }),
    { label: "chat" }
  );
  return { stream, recalled: ctx.ids, recalledNames: ctx.names, requestMessages };
}

/** 🧠 Tool-called memory write: the chat model decided mid-reply that something
 *  was worth saving, so the gating cost already rode on the reply call. Validates
 *  + persists exactly like silent extraction; the known set stays empty —
 *  persistExtraction resolves names against the DB itself (exact → norm → vector). */
/** Repair malformed streamed tool-call arguments before parsing.
 *  Ported from Hermes `_repair_tool_call_arguments` (message_sanitization.py:195):
 *  models streaming JSON args occasionally emit trailing commas, raw control
 *  chars inside strings, or unbalanced closers. Progressive passes, each only
 *  attempted while parsing still fails. Returns a parseable string, or null. */
function repairToolArguments(argsJson: string): string | null {
  const attempt = (text: string): string | null => {
    try {
      JSON.parse(text);
      return text;
    } catch {
      return null;
    }
  };

  const s = (argsJson ?? "").trim();
  if (!s) return "{}"; // empty args = empty object
  const direct = attempt(s);
  if (direct !== null) return direct;

  // Pass 1: strip trailing commas before } or ]
  let t = s.replace(/,\s*([}\]])/g, "$1");
  let ok = attempt(t);
  if (ok !== null) return ok;

  // Pass 2: escape raw control characters inside string literals
  let out = "";
  let inStr = false;
  let esc = false;
  for (const ch of t) {
    if (esc) {
      out += ch;
      esc = false;
      continue;
    }
    if (ch === "\\" && inStr) {
      out += ch;
      esc = true;
      continue;
    }
    if (ch === '"') {
      inStr = !inStr;
      out += ch;
      continue;
    }
    if (inStr && ch < " ") {
      out += ch === "\n" ? "\\n" : ch === "\t" ? "\\t" : ch === "\r" ? "\\r" : "";
      continue;
    }
    out += ch;
  }
  t = out;
  ok = attempt(t);
  if (ok !== null) return ok;

  // Pass 3: close an unterminated string, then append missing closers
  if (inStr) t += '"';
  const stack: string[] = [];
  inStr = false;
  esc = false;
  for (const ch of t) {
    if (esc) {
      esc = false;
      continue;
    }
    if (ch === "\\" && inStr) {
      esc = true;
      continue;
    }
    if (ch === '"') {
      inStr = !inStr;
      continue;
    }
    if (inStr) continue;
    if (ch === "{" || ch === "[") stack.push(ch);
    else if (ch === "}" || ch === "]") stack.pop();
  }
  while (stack.length) t += stack.pop() === "{" ? "}" : "]";
  ok = attempt(t);
  if (ok !== null) return ok;

  // Pass 4: bounded trim of excess trailing closers
  for (let i = 0; i < 8 && t.trimEnd().length; i++) {
    const trimmed = t.trimEnd();
    const last = trimmed.slice(-1);
    if (last !== "}" && last !== "]") break;
    t = trimmed.slice(0, -1);
    ok = attempt(t);
    if (ok !== null) return ok;
  }
  return null;
}

/** 🧠 Tool-called memory write: the chat model decided mid-reply that something
 *  was worth saving, so the gating cost already rode on the reply call. Validates
 *  + persists exactly like silent extraction; the known set stays empty —
 *  persistExtraction resolves names against the DB itself (exact → norm → vector).
 *  Malformed streamed args are repaired (Hermes-style) before parsing. */
export async function applyRemembered(sourceText: string, argsJson: string) {
  const repaired = repairToolArguments(argsJson);
  if (repaired === null) {
    console.error("🧠 remember: unrepairable tool arguments:", argsJson.slice(0, 500));
    return { ok: false as const, error: "tool arguments were not valid JSON (repair failed)" };
  }
  if (repaired !== (argsJson ?? "").trim()) {
    console.warn("🧠 remember: tool arguments needed repair");
  }
  const raw: unknown = JSON.parse(repaired);
  const parsed = Extraction.safeParse(raw);
  if (!parsed.success) {
    return { ok: false as const, error: "schema validation failed", issues: parsed.error.issues };
  }
  // Hermes threat scan (tools/threat_patterns.py, strict subset): remembered
  // content is later injected into the system prompt — a stored injection is a
  // persistent jailbreak, a stored credential a lasting leak. Refuse poisoned
  // writes; the truthful ✗ result lets the model self-correct (see route.ts).
  const threat = scanMemoryContent(JSON.stringify(parsed.data));
  if (threat) {
    console.warn("🧠 remember blocked by content scan:", threat);
    return { ok: false as const, error: `memory write blocked by content scan (${threat})` };
  }
  const r = await applyExtraction(sourceText, parsed.data, []);
  // M7 (Hermes no-op success): a save that created nothing, linked nothing and
  // changed nothing is "already known" — surface that truthfully so the model
  // stops re-saving the same fact every time it comes up.
  const unchanged =
    r.created.length === 0 &&
    r.edgesCreated === 0 &&
    r.updated.length === 0 &&
    r.forgotten.length === 0;
  return { ok: true as const, ...r, unchanged };
}

/** Phase 2 of the tool loop: the model called remember INSTEAD of replying
 *  (empty content). Feed the tool result back and stream the real reply —
 *  no tools this time, so the loop can't recurse. */
export async function continueChat(
  requestMessages: ChatCompletionMessageParam[],
  toolCalls: { id: string; name: string; arguments: string }[],
  results: string[],
  allowRememberRetry = false
) {
  const calls = toolCalls.map((tc, i) => ({
    id: tc.id || `call_${i}`,
    type: "function" as const,
    function: { name: tc.name, arguments: tc.arguments },
  }));
  return withRetry(
    () =>
      ai().chat.completions.create({
        model: CHAT_MODEL,
        stream: true,
        // One-shot retry: re-attach the remember tool only when a save failed.
        // The route never runs a phase 3, so the loop cannot recurse.
        ...(allowRememberRetry
          ? { tools: [REMEMBER_TOOL], tool_choice: "auto" as const }
          : {}),
        messages: [
          ...requestMessages,
          { role: "assistant", content: null, tool_calls: calls },
          ...calls.map(
            (c, i): ChatCompletionMessageParam => ({
              role: "tool",
              tool_call_id: c.id,
              content: results[i] ?? "✓ Saved to long-term memory.",
            })
          ),
        ],
      }),
    { label: "continueChat" }
  );
}

/** 🌙 Safety-net extraction over a conversation stretch — catches lasting facts
 *  the in-reply remember tool didn't fire on. Runs at digest cadence (~12 msgs),
 *  so extraction cost amortizes ~12× vs the old per-message silent extraction. */
export async function extractFromStretch(messages: ChatMessage[]) {
  const transcript = messages
    .filter((m) => m.content.trim())
    .map((m) => `${m.role === "user" ? "User" : "Sanctum"}: ${m.content}`)
    .join("\n")
    .slice(0, 6000);
  if (!transcript) return { ok: false as const, error: "empty stretch" };
  return runExtraction(transcript);
}

/** 🏷️ X5 stage 2 — upgrade the deterministic first-message slice into a real
 *  title. Small temp-0 call over the recent transcript; validated + capped.
 *  Best-effort: returns null on any failure (the derived title stays). */
export async function titleForSession(messages: ChatMessage[]): Promise<string | null> {
  const transcript = messages
    .slice(-8)
    .map((m) => `${m.role === "user" ? "User" : "Sanctum"}: ${m.content.slice(0, 200)}`)
    .join("\n")
    .slice(0, 2000);
  if (!transcript) return null;
  try {
    const res = await withRetry(
      () =>
        ai().chat.completions.create({
          model: CHAT_MODEL,
          temperature: 0,
          max_tokens: 24,
          messages: [
            {
              role: "system",
              content:
                "Title this conversation in 3–6 words. No quotes, no trailing period, no 'Title:' prefix — just the title.",
            },
            { role: "user", content: transcript },
          ],
        }),
      { attempts: 2, label: "title" }
    );
    const t = res.choices[0]?.message?.content?.trim().replace(/^["']+|["'.!?…]+$/g, "");
    return t && t.length <= 60 ? t : null;
  } catch {
    return null;
  }
}

/**
 * 🌙 Session digest: condense a stretch of conversation into a graph-visible
 * Conversation node, linked to everything it touched. Called automatically every
 * 6 messages and explicitly when a session ends (clear-chat).
 */
export async function summarizeConversation(messages: ChatMessage[]) {
  const substantive = messages.filter((m) => m.content.trim());
  if (substantive.length < 4) return { ok: false as const, reason: "too short to digest" };

  const [digestMd, known] = await Promise.all([brain("digest.md"), recentNodes(60)]);
  // Hermes micro-compaction asymmetry (docs/micro-compaction.md): user messages
  // are the source of truth and stay (near-)verbatim; assistant turns are
  // derived narration, truncated hard — the gist survives, the tokens don't.
  const joined = substantive
    .map((m) => {
      const body = m.role === "user" ? m.content.slice(0, 1200) : m.content.slice(0, 280);
      return `${m.role === "user" ? "User" : "Sanctum"}: ${body}`;
    })
    .join("\n");
  // Keep the RECENT end of the stretch; drop a possibly-partial first line.
  const transcript =
    joined.length <= 6000 ? joined : joined.slice(joined.length - 6000).replace(/^[^\n]*\n/, "");

  const parsedJson = await chatJson(
    `${digestMd}\n\n# Known memory nodes (for "mentioned")\n${known.map((n) => `- ${n.name}`).join("\n") || "(none)"}\n\nToday's date: ${localToday()}`,
    transcript
  );
  if (parsedJson === null) return { ok: false as const, error: "model did not return valid JSON (after retry)" };
  const parsed = Digest.safeParse(parsedJson);
  if (!parsed.success) return { ok: false as const, error: "schema validation failed" };

  const ids: string[] = [];
  for (const name of parsed.data.mentioned) {
    const id = await findNode(name);
    if (id && !ids.includes(id)) ids.push(id);
  }
  const digest = await createDigest({
    summary: parsed.data.summary,
    messageCount: substantive.length,
    mentionedIds: ids,
  });
  return { ok: true as const, ...digest };
}

/**
 * 😴 Consolidation — the sleep cycle. Reviews graph health + feedback and:
 * promotes repeated patterns into the user's profile, merges true duplicates
 * (only with apply=true), and reports stale forgetting candidates. Brain: consolidate.md
 */
export async function runConsolidation(opts: { apply?: boolean } = {}) {
  const [md, profile, dupes, stale, recent, thumbsDown] = await Promise.all([
    brain("consolidate.md"),
    ensureProfile(),
    dupeCandidates(0.8),
    staleNodes(),
    recentNodes(40),
    recentNegativeFeedback(10),
  ]);

  const parsedJson = await chatJson(
    `${md}\n\nToday's date: ${localToday()}`,
    [
      `# User profile node\n${profile.name} ${JSON.stringify(profile.attrs)}`,
      `# Duplicate candidates (embedding-similar pairs)\n${
        dupes.map((d) => `- "${d.a_name}" ≈ "${d.b_name}" (similarity ${d.sim.toFixed(2)})`).join("\n") || "(none)"
      }`,
      `# Recent 👎 feedback on replies\n${
        thumbsDown.map((f) => `- user: "${f.user_msg.slice(0, 140)}" → reply: "${f.assistant_msg.slice(0, 200)}"`).join("\n") || "(none)"
      }`,
      `# Live memory nodes\n${recent.map((n) => `- ${n.name} [${n.type}]`).join("\n") || "(none)"}`,
    ].join("\n\n")
  );
  if (parsedJson === null) return { ok: false as const, error: "model did not return valid JSON (after retry)" };
  const parsed = Consolidation.safeParse(parsedJson);
  if (!parsed.success) return { ok: false as const, error: "schema validation failed" };

  const { profile_updates, merges, insight } = parsed.data;

  // Profile promotion is always safe — merge attrs onto the user's node
  if (Object.keys(profile_updates).length || insight) {
    await updateNode(PROFILE_NAME, {
      setAttrs: {
        ...profile_updates,
        ...(insight ? { "insight.latest": insight, "insight.date": localToday() } : {}),
      },
    });
  }

  const appliedMerges: string[] = [];
  if (opts.apply) {
    for (const m of merges) {
      const keepId = await findNode(m.keep);
      const dropId = await findNode(m.drop);
      if (keepId && dropId && keepId !== dropId && (await mergeNodes(keepId, dropId))) {
        appliedMerges.push(`${m.drop} → ${m.keep}`);
      }
    }
  }

  return {
    ok: true as const,
    insight,
    profileUpdates: Object.keys(profile_updates),
    merges: opts.apply ? { applied: appliedMerges } : { proposed: merges.map((m) => `${m.drop} → ${m.keep}`) },
    staleCandidates: stale.map((s) => `${s.name} [${s.type}]`),
  };
}

export async function answerQuestion(question: string) {
  // One retrieval, used twice: buildContext's salience-ranked nodes ARE the
  // "recalled" list — previously this re-ran searchNodes(question, 8), burning a
  // second identical embedding + scan for the same answer.
  const [answerMd, ctx] = await Promise.all([brain("answer.md"), buildContext(question)]);

  const res = await withRetry(
    () =>
      ai().chat.completions.create({
        model: CHAT_MODEL,
        messages: [
          { role: "system", content: answerMd },
          { role: "user", content: `Context:\n${ctx.text}\n\nQuestion: ${question}` },
        ],
      }),
    { label: "ask" }
  );

  return {
    answer: res.choices[0]?.message?.content ?? "",
    recalled: Object.values(ctx.names),
  };
}
