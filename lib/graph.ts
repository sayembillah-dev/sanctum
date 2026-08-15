import { prisma } from "./db";
import { embed } from "./ai";
import type { Prisma } from "@prisma/client";

const DEDUP_THRESHOLD = 0.85; // cosine similarity ≥ 0.85 → same entity (0.9 was too strict → duplicate nodes)

const lit = (v: number[]) => `[${v.join(",")}]`;
const today = () => new Date().toLocaleDateString("en-CA"); // local YYYY-MM-DD
const asDate = (d: string) => new Date(`${d}T00:00:00`); // @db.Date columns

/** The user's own memory node — the pinned sun of the cosmos. Everything Sanctum
 *  knows about its user accrues in this node's attrs (see brain/extract.md "user model"). */
export const PROFILE_NAME = "Sayem Billah";

export async function insertDump(rawText: string): Promise<string> {
  const d = await prisma.dump.create({ data: { raw_text: rawText }, select: { id: true } });
  return d.id;
}

/**
 * Read-only node lookup: exact → normalized → embedding-similar. Never creates.
 * Closed (forgotten) nodes are invisible here — they can never match.
 */
export async function findNode(name: string): Promise<string | null> {
  const exact = await prisma.node.findFirst({
    where: { name: { equals: name, mode: "insensitive" }, valid_to: null },
    select: { id: true },
  });
  if (exact) return exact.id;

  // normalized: "EV-bike" / "ev bike" / "EV Bike!" all collapse together
  const norm = await prisma.$queryRaw<{ id: string }[]>`
    select id from nodes
    where regexp_replace(lower(name), '[^a-z0-9]+', '', 'g')
        = regexp_replace(lower(${name}), '[^a-z0-9]+', '', 'g')
      and valid_to is null
    limit 1`;
  if (norm[0]) return norm[0].id;

  const vector = lit(await embed(`entity: ${name}`));
  const sim = await prisma.$queryRaw<{ id: string; score: number }[]>`
    select id, 1 - (embedding <=> ${vector}::vector) as score
    from nodes where embedding is not null and valid_to is null
    order by embedding <=> ${vector}::vector limit 1`;
  return sim[0] && sim[0].score >= DEDUP_THRESHOLD ? sim[0].id : null;
}

/** Exact → normalized → embedding-similarity match → create. Returns node id + whether it was created.
 *  A match strengthens the node (mention_count +1) — salience grows with use. */
export async function resolveNode(n: {
  type: string;
  name: string;
  attrs: Record<string, unknown>;
}): Promise<{ id: string; wasCreated: boolean }> {
  const strengthen = async (id: string) => {
    await prisma.node.update({ where: { id }, data: { mention_count: { increment: 1 } } });
    return { id, wasCreated: false };
  };

  const exact = await prisma.node.findFirst({
    where: { name: { equals: n.name, mode: "insensitive" }, valid_to: null },
    select: { id: true },
  });
  if (exact) return strengthen(exact.id);

  const norm = await prisma.$queryRaw<{ id: string }[]>`
    select id from nodes
    where regexp_replace(lower(name), '[^a-z0-9]+', '', 'g')
        = regexp_replace(lower(${n.name}), '[^a-z0-9]+', '', 'g')
      and valid_to is null
    limit 1`;
  if (norm[0]) return strengthen(norm[0].id);

  const vector = lit(await embed(`${n.type}: ${n.name} ${JSON.stringify(n.attrs)}`));
  const sim = await prisma.$queryRaw<{ id: string; score: number }[]>`
    select id, 1 - (embedding <=> ${vector}::vector) as score
    from nodes where embedding is not null and valid_to is null
    order by embedding <=> ${vector}::vector limit 1`;
  if (sim[0] && sim[0].score >= DEDUP_THRESHOLD) return strengthen(sim[0].id);

  const ins = await prisma.node.create({
    data: { type: n.type, name: n.name, attrs: n.attrs as Prisma.InputJsonValue },
    select: { id: true },
  });
  await prisma.$executeRaw`update nodes set embedding = ${vector}::vector where id = ${ins.id}::uuid`;
  return { id: ins.id, wasCreated: true };
}

/**
 * Insert an edge, skipping exact duplicates (same src, dst, type, still valid).
 * Returns true if a new edge was actually created.
 */
export async function createEdge(e: {
  srcId: string;
  dstId: string;
  type: string;
  saidOn?: string;
  dumpId?: string;
}): Promise<boolean> {
  if (e.srcId === e.dstId) return false; // no self-loops
  const dupe = await prisma.edge.findFirst({
    where: { src_id: e.srcId, dst_id: e.dstId, type: e.type, valid_to: null },
    select: { id: true },
  });
  if (dupe) return false; // already known — restating a fact adds nothing
  await prisma.edge.create({
    data: {
      src_id: e.srcId,
      dst_id: e.dstId,
      type: e.type,
      said_on: e.saidOn ? asDate(e.saidOn) : null,
      valid_from: e.saidOn ? asDate(e.saidOn) : null,
      source_dump_id: e.dumpId ?? null,
    },
  });
  return true;
}

/**
 * Update an existing node: merge attrs (new keys overwrite), optionally rename.
 * Re-embeds since the meaning changed. Returns null if the node doesn't exist.
 */
export async function updateNode(
  name: string,
  u: { setAttrs?: Record<string, unknown>; rename?: string }
): Promise<{ id: string; name: string } | null> {
  const id = await findNode(name);
  if (!id) return null;
  const row = await prisma.node.findUnique({ where: { id } });
  if (!row) return null;
  const newName = u.rename?.trim() || row.name;
  const newAttrs = {
    ...((row.attrs as Record<string, unknown> | null) ?? {}),
    ...(u.setAttrs ?? {}),
  };
  const vector = lit(await embed(`${row.type}: ${newName} ${JSON.stringify(newAttrs)}`));
  await prisma.node.update({
    where: { id },
    data: { name: newName, attrs: newAttrs as Prisma.InputJsonValue, updated_at: new Date() },
  });
  await prisma.$executeRaw`update nodes set embedding = ${vector}::vector where id = ${id}::uuid`;
  return { id, name: newName };
}

/** Close active edges of a node whose type is in `types` (superseded facts). Returns count closed. */
export async function closeEdges(nodeId: string, types: string[]): Promise<number> {
  if (!types.length) return 0;
  const r = await prisma.edge.updateMany({
    where: {
      OR: [{ src_id: nodeId }, { dst_id: nodeId }],
      type: { in: types },
      valid_to: null,
    },
    data: { valid_to: asDate(today()) },
  });
  return r.count;
}

/**
 * Forget a node (user-initiated): soft-close it and every active edge touching it.
 * The row stays in the DB as history, but recall, extraction and the graph view
 * all filter valid_to — to Sanctum, it's gone.
 */
export async function forgetNode(name: string): Promise<{ id: string; name: string } | null> {
  const id = await findNode(name);
  if (!id) return null;
  await prisma.node.update({ where: { id }, data: { valid_to: asDate(today()) } });
  await prisma.edge.updateMany({
    where: { OR: [{ src_id: id }, { dst_id: id }], valid_to: null },
    data: { valid_to: asDate(today()) },
  });
  return { id, name };
}

/** Most recently created live nodes — gives the extractor awareness of the current graph. */
export async function recentNodes(limit = 20) {
  return prisma.node.findMany({
    where: { valid_to: null },
    orderBy: { created_at: "desc" },
    take: limit,
    select: { id: true, type: true, name: true },
  });
}

/** Semantic search: top live nodes related to a question (raw cosine — reranking happens in the agent). */
export async function searchNodes(question: string, limit = 5) {
  const vector = lit(await embed(question));
  return prisma.$queryRaw<
    { id: string; type: string; name: string; attrs: unknown; score: number; mention_count: number }[]
  >`
    select id, type, name, attrs, mention_count,
           1 - (embedding <=> ${vector}::vector) as score
    from nodes where embedding is not null and valid_to is null
    order by embedding <=> ${vector}::vector limit ${limit}`;
}

/** Active edges touching any of the given live nodes (the 1-hop neighborhood). */
export async function nodeEdges(ids: string[]) {
  if (!ids.length) return [];
  const rows = await prisma.edge.findMany({
    where: {
      OR: [{ src_id: { in: ids } }, { dst_id: { in: ids } }],
      valid_to: null,
      src: { is: { valid_to: null } },
      dst: { is: { valid_to: null } },
    },
    select: {
      type: true,
      said_on: true,
      src: { select: { name: true } },
      dst: { select: { name: true } },
    },
  });
  return rows.map((e) => ({
    type: e.type,
    said_on: e.said_on ? e.said_on.toISOString().slice(0, 10) : null,
    valid_to: null as string | null, // filtered to active — kept for prompt-format compat
    src: e.src.name,
    dst: e.dst.name,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// 🌱 Grows-With-You: profile, salience bookkeeping, open loops, digests, feedback
// ─────────────────────────────────────────────────────────────────────────────

/** Get-or-create the pinned profile node. Idempotent; pins a name-match if one already exists. */
export async function ensureProfile() {
  const existing = await prisma.node.findFirst({ where: { pinned: true, valid_to: null } });
  if (existing) return existing;

  const byName = await findNode(PROFILE_NAME);
  if (byName) {
    await prisma.node.update({ where: { id: byName }, data: { pinned: true } });
    return (await prisma.node.findUnique({ where: { id: byName } }))!;
  }

  const node = await prisma.node.create({
    data: {
      type: "Person",
      name: PROFILE_NAME,
      pinned: true,
      attrs: {
        role: "the user — owner of this Sanctum",
        note: "Everything Sanctum learns about its user accrues here.",
      } as Prisma.InputJsonValue,
    },
  });
  const vector = lit(await embed(`Person: ${PROFILE_NAME} — the user, owner of this Sanctum`));
  await prisma.$executeRaw`update nodes set embedding = ${vector}::vector where id = ${node.id}::uuid`;
  return node;
}

/** Recall side-effect: these nodes were surfaced into a prompt (attention, not yet usage). */
export async function markRecalled(ids: string[]) {
  if (!ids.length) return;
  await prisma.node.updateMany({
    where: { id: { in: ids } },
    data: { last_recalled_at: new Date() },
  });
}

/** Usage signal: the final reply actually cited these nodes → they're proven-relevant. */
export async function markRecallUsed(ids: string[]) {
  if (!ids.length) return;
  await prisma.node.updateMany({
    where: { id: { in: ids } },
    data: { recall_used_count: { increment: 1 } },
  });
}

export type OpenLoop = { name: string; due: string | null; overdue: boolean };

/** Unresolved threads: live tasks that aren't done — overdue/near-due first. Capped. */
export async function openLoops(): Promise<OpenLoop[]> {
  const tasks = await prisma.node.findMany({
    where: { valid_to: null, type: { equals: "Task", mode: "insensitive" } },
    select: { name: true, attrs: true },
  });
  const t = today();
  const loops: OpenLoop[] = [];
  for (const task of tasks) {
    const a = (task.attrs ?? {}) as Record<string, unknown>;
    const status = String(a.status ?? "").toLowerCase();
    if (["done", "completed", "cancelled", "closed"].includes(status)) continue;
    const raw = typeof a.due === "string" ? a.due : null;
    const due = raw && /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(0, 10) : null;
    loops.push({ name: task.name, due, overdue: !!due && due < t });
  }
  return loops.sort((x, y) => (x.due ?? "9999").localeCompare(y.due ?? "9999")).slice(0, 6);
}

/** Crystallize a conversation into a graph-visible digest node, linked to everything it touched. */
export async function createDigest(d: {
  summary: string;
  messageCount: number;
  mentionedIds: string[];
}) {
  // name from the summary itself — meaningful in recall & the cosmos; timestamp stays in attrs
  const gist = d.summary.replace(/\s+/g, " ").trim();
  const name = `💬 ${gist.slice(0, 60)}${gist.length > 60 ? "…" : ""}`;
  const node = await prisma.node.create({
    data: {
      type: "Conversation",
      name,
      attrs: {
        summary: d.summary,
        message_count: d.messageCount,
        date: today(),
      } as Prisma.InputJsonValue,
    },
    select: { id: true },
  });
  const vector = lit(await embed(`Conversation: ${d.summary}`));
  await prisma.$executeRaw`update nodes set embedding = ${vector}::vector where id = ${node.id}::uuid`;
  let linked = 0;
  for (const id of d.mentionedIds) {
    if (id !== node.id && (await createEdge({ srcId: node.id, dstId: id, type: "mentions" }))) linked++;
  }
  return { id: node.id, name, linked };
}

/** Store a 👍/👎 on a reply — consolidation reads these to correct itself. */
export async function addFeedback(f: { rating: number; userMsg: string; assistantMsg: string }) {
  await prisma.feedback.create({
    data: {
      rating: f.rating,
      user_msg: f.userMsg.slice(0, 4000),
      assistant_msg: f.assistantMsg.slice(0, 4000),
    },
  });
}

/** "What I learned this week" — growth made visible. */
export async function weeklyRecap() {
  const since = new Date(Date.now() - 7 * 864e5);
  const [nodes, edgeCount, fb, top] = await Promise.all([
    prisma.node.findMany({
      where: { created_at: { gte: since }, valid_to: null },
      select: { type: true, name: true },
      orderBy: { created_at: "desc" },
    }),
    prisma.edge.count({ where: { created_at: { gte: since } } }),
    prisma.feedback.groupBy({ by: ["rating"], where: { created_at: { gte: since } }, _count: true }),
    prisma.node.findMany({
      where: { valid_to: null, pinned: false },
      orderBy: { mention_count: "desc" },
      take: 5,
      select: { name: true, type: true, mention_count: true },
    }),
  ]);
  const byType: Record<string, number> = {};
  for (const n of nodes) byType[n.type] = (byType[n.type] ?? 0) + 1;
  return {
    newNodes: nodes.length,
    newEdges: edgeCount,
    byType,
    newest: nodes.slice(0, 8).map((n) => ({ name: n.name, type: n.type })),
    topMentioned: top,
    feedback: { up: fb.find((f) => f.rating === 1)?._count ?? 0, down: fb.find((f) => f.rating === -1)?._count ?? 0 },
  };
}

// ─── Consolidation helpers (the sleep cycle) ───

/** Embedding-similar live node pairs — merge candidates for the consolidation agent. */
export async function dupeCandidates(minSim = 0.8) {
  return prisma.$queryRaw<{ a_id: string; a_name: string; b_id: string; b_name: string; sim: number }[]>`
    select a.id as a_id, a.name as a_name, b.id as b_id, b.name as b_name,
           1 - (a.embedding <=> b.embedding) as sim
    from nodes a
    join nodes b on a.id < b.id
    where a.valid_to is null and b.valid_to is null
      and a.embedding is not null and b.embedding is not null
      and 1 - (a.embedding <=> b.embedding) >= ${minSim}
    order by sim desc
    limit 20`;
}

/**
 * Merge `dropId` into `keepId`: re-point live edges (deduping), merge attrs (keep wins),
 * pool mention counts, re-embed, then soft-close the dropped node. History preserved.
 */
export async function mergeNodes(keepId: string, dropId: string): Promise<boolean> {
  const [keep, drop] = await Promise.all([
    prisma.node.findUnique({ where: { id: keepId } }),
    prisma.node.findUnique({ where: { id: dropId } }),
  ]);
  if (!keep || !drop || keepId === dropId) return false;

  const edges = await prisma.edge.findMany({
    where: { OR: [{ src_id: dropId }, { dst_id: dropId }], valid_to: null },
  });
  for (const e of edges) {
    const srcId = e.src_id === dropId ? keepId : e.src_id;
    const dstId = e.dst_id === dropId ? keepId : e.dst_id;
    if (srcId !== dstId) {
      await createEdge({
        srcId,
        dstId,
        type: e.type,
        saidOn: e.said_on ? e.said_on.toISOString().slice(0, 10) : undefined,
        dumpId: e.source_dump_id ?? undefined,
      });
    }
  }

  const mergedAttrs = {
    ...((drop.attrs as Record<string, unknown> | null) ?? {}),
    ...((keep.attrs as Record<string, unknown> | null) ?? {}),
  };
  const vector = lit(await embed(`${keep.type}: ${keep.name} ${JSON.stringify(mergedAttrs)}`));
  await prisma.node.update({
    where: { id: keepId },
    data: {
      attrs: mergedAttrs as Prisma.InputJsonValue,
      mention_count: keep.mention_count + drop.mention_count,
      updated_at: new Date(),
    },
  });
  await prisma.$executeRaw`update nodes set embedding = ${vector}::vector where id = ${keepId}::uuid`;

  await prisma.node.update({ where: { id: dropId }, data: { valid_to: asDate(today()) } });
  await prisma.edge.updateMany({
    where: { OR: [{ src_id: dropId }, { dst_id: dropId }], valid_to: null },
    data: { valid_to: asDate(today()) },
  });
  return true;
}

/** Forgetting candidates: old, mentioned once, never used in a reply, not pinned. Report only. */
export async function staleNodes() {
  return prisma.node.findMany({
    where: {
      valid_to: null,
      pinned: false,
      mention_count: { lte: 1 },
      recall_used_count: 0,
      created_at: { lt: new Date(Date.now() - 30 * 864e5) },
    },
    select: { name: true, type: true, created_at: true },
    orderBy: { created_at: "asc" },
    take: 20,
  });
}

/** Recent 👎 replies — the consolidation agent infers style corrections from these. */
export async function recentNegativeFeedback(take = 10) {
  return prisma.feedback.findMany({
    where: { rating: -1 },
    orderBy: { created_at: "desc" },
    take,
    select: { user_msg: true, assistant_msg: true },
  });
}

/** Full live-graph snapshot for the neuron view (force-graph wants { nodes, links }). */
export async function graphSnapshot() {
  // Conversation digests stay in recall but never render in the cosmos
  const nodes = await prisma.node.findMany({
    where: { valid_to: null, type: { not: "Conversation" } },
    orderBy: { created_at: "asc" },
    select: { id: true, type: true, name: true, pinned: true, mention_count: true },
  });
  const ids = new Set(nodes.map((n) => n.id));
  const edges = (
    await prisma.edge.findMany({
      where: { valid_to: null },
      select: { src_id: true, dst_id: true, type: true },
    })
  ).filter((e) => ids.has(e.src_id) && ids.has(e.dst_id));
  return {
    nodes,
    links: edges.map((e) => ({ source: e.src_id, target: e.dst_id, type: e.type })),
  };
}
