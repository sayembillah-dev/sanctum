import OpenAI from "openai";

// Azure Foundry — OpenAI-compatible. One endpoint, one key: chat + embeddings.
// Lazy: instantiated on first call, not at import time (keeps `next build` happy without env vars).
let client: OpenAI | null = null;

export function ai(): OpenAI {
  if (!client) {
    client = new OpenAI({
      baseURL: process.env.AZURE_FOUNDRY_ENDPOINT,
      apiKey: process.env.AZURE_FOUNDRY_API_KEY,
    });
  }
  return client;
}

export const CHAT_MODEL = "FW-Kimi-K3";
export const EMBED_MODEL = "text-embedding-3-large";
export const EMBED_DIMS = 1536; // pgvector HNSW caps at 2000 dims — always request 1536

/** The ONE canonical text shape a node is embedded as. Anything querying nodes by
 *  similarity must stay in this shape family — findNode used to embed
 *  "entity: {name}" against "{type}: {name} {attrs}" vectors, degrading the math. */
export const embedNodeText = (type: string, name: string, attrs: unknown): string =>
  `${type}: ${name} ${JSON.stringify(attrs ?? {})}`;

// ── Embedding cache ──────────────────────────────────────────────────────────
// Identical texts recur within one request (double searches) and across chats
// (repeated phrasings). Small LRU + in-flight dedupe: concurrent identical
// embeds share a single HTTP call.
const EMBED_CACHE_MAX = 256;
const embedCache = new Map<string, number[]>();
const inflight = new Map<string, Promise<number[]>>();

function cacheGet(text: string): number[] | undefined {
  const hit = embedCache.get(text);
  if (hit) {
    embedCache.delete(text); // LRU touch
    embedCache.set(text, hit);
  }
  return hit;
}

function cacheSet(text: string, vec: number[]) {
  embedCache.set(text, vec);
  if (embedCache.size > EMBED_CACHE_MAX) {
    embedCache.delete(embedCache.keys().next().value as string); // evict oldest
  }
}

export async function embed(text: string): Promise<number[]> {
  const hit = cacheGet(text);
  if (hit) return hit;
  const pending = inflight.get(text);
  if (pending) return pending; // share the in-flight HTTP call
  const p = embedBatch([text])
    .then((v) => v[0])
    .finally(() => inflight.delete(text));
  inflight.set(text, p);
  return p;
}

/** Batch embedding: ONE HTTP call for N texts (the embeddings API accepts arrays).
 *  Cache-aware and order-preserving — extraction embeds all new nodes in a single
 *  round trip instead of one call per node. */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (!texts.length) return [];
  const out: (number[] | undefined)[] = new Array(texts.length);
  const missingIdx: number[] = [];
  const missingTexts: string[] = [];
  texts.forEach((t, i) => {
    const hit = cacheGet(t);
    if (hit) out[i] = hit;
    else {
      missingIdx.push(i);
      missingTexts.push(t);
    }
  });
  if (missingTexts.length) {
    const res = await ai().embeddings.create({
      model: EMBED_MODEL,
      input: missingTexts,
      dimensions: EMBED_DIMS,
    });
    for (const d of res.data) {
      const i = missingIdx[d.index];
      out[i] = d.embedding;
      cacheSet(missingTexts[d.index], d.embedding);
    }
  }
  return out as number[][];
}
