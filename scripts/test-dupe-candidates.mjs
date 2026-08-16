// B8 verification: the lateral-HNSW dupeCandidates must return the same pairs as
// the old O(n²) self-join (normalized: orientation-insensitive pair keys, sim within
// fp tolerance). Also times both. Read-only against live Neon.
import fs from "node:fs";
import path from "node:path";
import pg from "pg";

const envPath = path.resolve(".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
if (!process.env.DATABASE_URL) {
  console.warn("DATABASE_URL not set — skipping");
  process.exit(0);
}
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const MIN_SIM = 0.8;
const OLD_SQL = `select a.id as a_id, b.id as b_id, 1 - (a.embedding <=> b.embedding) as sim
  from nodes a join nodes b on a.id < b.id
  where a.valid_to is null and b.valid_to is null
    and a.embedding is not null and b.embedding is not null
    and 1 - (a.embedding <=> b.embedding) >= $1
  order by sim desc limit 20`;
const NEW_SQL = `select a.id as a_id, b.id as b_id, 1 - (a.embedding <=> b.embedding) as sim
  from nodes a
  cross join lateral (
    select b.id, b.name, b.embedding from nodes b
    where b.valid_to is null and b.embedding is not null and b.id <> a.id
    order by b.embedding <=> a.embedding limit 3
  ) b
  where a.valid_to is null and a.embedding is not null
    and 1 - (a.embedding <=> b.embedding) >= $1
  order by sim desc limit 40`;

const key = (r) => (r.a_id < r.b_id ? `${r.a_id}|${r.b_id}` : `${r.b_id}|${r.a_id}`);
const normalize = (rows) => {
  const m = new Map();
  for (const r of rows) if (!m.has(key(r))) m.set(key(r), Number(r.sim));
  return m;
};

try {
  const t0 = performance.now();
  const oldRows = (await pool.query(OLD_SQL, [MIN_SIM])).rows;
  const t1 = performance.now();
  const newRowsRaw = (await pool.query(NEW_SQL, [MIN_SIM])).rows;
  const t2 = performance.now();

  const oldPairs = normalize(oldRows);
  const newPairs = normalize(newRowsRaw); // JS dedupe mirrors lib/graph.ts
  const newTop20 = [...newPairs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);

  const bad = [];
  const oldTop20Keys = new Set([...oldPairs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([k]) => k));
  const newKeys = new Set(newTop20.map(([k]) => k));
  for (const k of oldTop20Keys) if (!newKeys.has(k)) bad.push(`missing in NEW: ${k} (sim ${oldPairs.get(k)})`);
  for (const k of newKeys) {
    if (!oldTop20Keys.has(k)) bad.push(`extra in NEW: ${k} (sim ${newPairs.get(k)})`);
    else if (Math.abs(newPairs.get(k) - oldPairs.get(k)) > 1e-6) bad.push(`sim mismatch ${k}: ${oldPairs.get(k)} vs ${newPairs.get(k)}`);
  }

  console.log(`old O(n²): ${oldRows.length} pairs in ${(t1 - t0).toFixed(1)}ms`);
  console.log(`new HNSW : ${newPairs.size} pairs (raw ${newRowsRaw.length}) in ${(t2 - t1).toFixed(1)}ms`);
  if (oldRows.length) console.log(`top pair: ${oldRows[0].a_id.slice(0, 8)}~${oldRows[0].b_id.slice(0, 8)} sim=${Number(oldRows[0].sim).toFixed(4)}`);
  console.log(bad.length ? "FAILURES:\n" + bad.join("\n") : "DUPE-CANDIDATES-OK (identical pairs)");
  process.exit(bad.length ? 1 : 0);
} finally {
  await pool.end();
}
