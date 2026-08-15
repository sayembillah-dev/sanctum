import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ai, CHAT_MODEL } from "./ai";
import {
  insertDump,
  resolveNode,
  createEdge,
  searchNodes,
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

// The brain is markdown — code enforces invariants, markdown guides judgment.
const brain = (file: string) =>
  fs.readFile(path.join(process.cwd(), "brain", file), "utf8");

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

export type ChatMessage = { role: "user" | "assistant"; content: string };

// Retrieval guards: pgvector ALWAYS returns top-N, even when every hit is irrelevant —
// so without a similarity floor, unrelated nodes pollute the prompt (and waste tokens).
const MIN_RECALL_SCORE = 0.4; // cosine similarity floor for "this memory is actually relevant"
const MAX_RECALL_NODES = 8; // cap tokens
const MAX_RECALL_EDGES = 16; // cap 1-hop neighborhood expansion
const SALIENCE_WEIGHT = 0.08; // how much use boosts rank: ×(1 + ln(1+mentions)·w) — 30 mentions ≈ +27%

/**
 * Build memory context for a message: thresholded semantic search → salience rerank
 * → capped 1-hop neighborhood. The pinned profile node is excluded here (it's always
 * in context separately). Surfaced nodes get last_recalled_at stamped.
 */
async function buildContext(
  query: string,
  excludeId?: string
): Promise<{ text: string; ids: string[]; names: Record<string, string> }> {
  if (!query.trim()) return { text: "(no query)", ids: [], names: {} };
  const hits = await searchNodes(query, 12);
  const nodes = hits
    .filter((n) => n.score >= MIN_RECALL_SCORE && n.id !== excludeId)
    // 🌱 salience rerank: memories that get used rise; untouched trivia sinks
    .map((n) => ({ ...n, blended: n.score * (1 + Math.log1p(n.mention_count ?? 1) * SALIENCE_WEIGHT) }))
    .sort((a, b) => b.blended - a.blended)
    .slice(0, MAX_RECALL_NODES);
  if (!nodes.length) {
    return { text: "(nothing in memory is relevant to this message)", ids: [], names: {} };
  }
  const ids = nodes.map((n) => n.id);
  const edges = (await nodeEdges(ids)).slice(0, MAX_RECALL_EDGES);
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

  const res = await ai().chat.completions.create({
    model: CHAT_MODEL,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `${extractMd}\n\n# Current type registry\n${typesMd}\n\n# Existing memory nodes (reuse & link)\n${knownList}\n\n# The user\nThe person speaking IS "${profile.name}" — their profile node exists in the list above. Facts about THEM route there via updates (see "user model" rules).\n\nToday's date: ${localToday()}`,
      },
      { role: "user", content: text },
    ],
  });

  const raw = res.choices[0]?.message?.content ?? "{}";

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return { ok: false as const, error: "model did not return valid JSON", raw };
  }

  const parsed = Extraction.safeParse(parsedJson);
  if (!parsed.success) {
    return { ok: false as const, error: "schema validation failed", issues: parsed.error.issues, raw };
  }

  // --- Persist to the memory graph ---
  const dumpId = await insertDump(text);

  // Edge endpoints may reference existing memory by name — pre-seed the map
  const idByName = new Map<string, string>();
  for (const n of known.values()) idByName.set(n.name.toLowerCase(), n.id);

  const created: string[] = [];
  const reused: string[] = [];
  for (const n of parsed.data.nodes) {
    const { id, wasCreated } = await resolveNode(n);
    idByName.set(n.name.toLowerCase(), id);
    (wasCreated ? created : reused).push(n.name);
  }

  let edgesCreated = 0;
  for (const e of parsed.data.edges) {
    const srcId =
      idByName.get(e.src.toLowerCase()) ?? (await findNode(e.src)) ?? undefined;
    const dstId =
      idByName.get(e.dst.toLowerCase()) ?? (await findNode(e.dst)) ?? undefined;
    if (!srcId || !dstId) continue; // references something we truly don't know — skip
    if (await createEdge({ srcId, dstId, type: e.type, saidOn: e.said_on, dumpId })) {
      edgesCreated++;
    }
  }

  // --- Revision: update / supersede / forget existing memory ---
  const updated: string[] = [];
  const forgotten: string[] = [];
  for (const u of parsed.data.updates) {
    if (u.forget) {
      const f = await forgetNode(u.node);
      if (f) forgotten.push(f.name);
      continue;
    }
    const up = await updateNode(u.node, { setAttrs: u.set_attrs, rename: u.rename });
    if (up) {
      updated.push(up.name);
      idByName.set(up.name.toLowerCase(), up.id); // renamed node stays addressable
      if (u.close_edges.length) await closeEdges(up.id, u.close_edges);
    }
  }

  return { ok: true as const, dumpId, nodes: { created, reused }, edgesCreated, updated, forgotten };
}

/** Conversational chat: silent background memory write + grounded streamed reply.
 *  The profile and open loops are ALWAYS in context — this is what makes Sanctum
 *  feel like it knows you better every time. */
export async function chat(messages: ChatMessage[]) {
  const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";

  // Ensure the profile exists BEFORE extraction fires, so user-facts have a home
  const profile = await ensureProfile();

  // 🧠 Silent memory: fire-and-forget — the reply NEVER waits for extraction
  if (lastUser.trim()) {
    runExtraction(lastUser)
      .then((r) => console.log("🧠 memory:", JSON.stringify(r)))
      .catch((e) => console.error("🧠 memory write failed:", e));
  }

  const [chatMd, ctx, loops, profileEdges] = await Promise.all([
    brain("chat.md"),
    buildContext(lastUser, profile.id),
    openLoops(),
    nodeEdges([profile.id]),
  ]);

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

  const stream = await ai().chat.completions.create({
    model: CHAT_MODEL,
    stream: true,
    messages: [{ role: "system", content: system }, ...messages],
  });
  return { stream, recalled: ctx.ids, recalledNames: ctx.names };
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
  const transcript = substantive
    .map((m) => `${m.role === "user" ? "User" : "Sanctum"}: ${m.content}`)
    .join("\n")
    .slice(0, 6000);

  const res = await ai().chat.completions.create({
    model: CHAT_MODEL,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `${digestMd}\n\n# Known memory nodes (for "mentioned")\n${known.map((n) => `- ${n.name}`).join("\n") || "(none)"}\n\nToday's date: ${localToday()}`,
      },
      { role: "user", content: transcript },
    ],
  });

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(res.choices[0]?.message?.content ?? "{}");
  } catch {
    return { ok: false as const, error: "model did not return valid JSON" };
  }
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

  const res = await ai().chat.completions.create({
    model: CHAT_MODEL,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `${md}\n\nToday's date: ${localToday()}`,
      },
      {
        role: "user",
        content: [
          `# User profile node\n${profile.name} ${JSON.stringify(profile.attrs)}`,
          `# Duplicate candidates (embedding-similar pairs)\n${
            dupes.map((d) => `- "${d.a_name}" ≈ "${d.b_name}" (similarity ${d.sim.toFixed(2)})`).join("\n") || "(none)"
          }`,
          `# Recent 👎 feedback on replies\n${
            thumbsDown.map((f) => `- user: "${f.user_msg.slice(0, 140)}" → reply: "${f.assistant_msg.slice(0, 200)}"`).join("\n") || "(none)"
          }`,
          `# Live memory nodes\n${recent.map((n) => `- ${n.name} [${n.type}]`).join("\n") || "(none)"}`,
        ].join("\n\n"),
      },
    ],
  });

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(res.choices[0]?.message?.content ?? "{}");
  } catch {
    return { ok: false as const, error: "model did not return valid JSON" };
  }
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
  const answerMd = await brain("answer.md");
  const { text: context } = await buildContext(question);

  const res = await ai().chat.completions.create({
    model: CHAT_MODEL,
    messages: [
      { role: "system", content: answerMd },
      { role: "user", content: `Context:\n${context}\n\nQuestion: ${question}` },
    ],
  });

  const nodes = (await searchNodes(question, 8)).filter((n) => n.score >= MIN_RECALL_SCORE);
  return {
    answer: res.choices[0]?.message?.content ?? "",
    recalled: nodes.map((n) => n.name),
  };
}
