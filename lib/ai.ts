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

export async function embed(text: string): Promise<number[]> {
  const res = await ai().embeddings.create({
    model: EMBED_MODEL,
    input: text,
    dimensions: EMBED_DIMS,
  });
  return res.data[0].embedding;
}
