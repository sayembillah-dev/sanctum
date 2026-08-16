// B6 smoke: the graph version probe must be stable across calls (identical
// string when nothing changed) and well-formed. Mirrors graphVersion() in lib/graph.ts.
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

const SQL = `select concat_ws('.',
  (select count(*)::text from nodes where type <> 'Conversation'),
  (select coalesce(sum(mention_count), 0)::text from nodes where type <> 'Conversation'),
  (select coalesce(extract(epoch from max(updated_at))::bigint, 0)::text from nodes where type <> 'Conversation'),
  (select count(*)::text from nodes where valid_to is not null),
  (select count(*)::text from edges),
  (select count(*)::text from edges where valid_to is not null)
) as v`;

try {
  const a = (await pool.query(SQL)).rows[0].v;
  await new Promise((r) => setTimeout(r, 300));
  const b = (await pool.query(SQL)).rows[0].v;
  const parts = a.split(".");
  const bad = [];
  if (a !== b) bad.push(`unstable: "${a}" vs "${b}"`);
  if (parts.length !== 6) bad.push(`expected 6 segments, got ${parts.length}: "${a}"`);
  if (parts.some((p) => !/^\d+$/.test(p))) bad.push(`non-numeric segment in "${a}"`);
  // timing: probe must be cheap
  const t0 = performance.now();
  await pool.query(SQL);
  const ms = (performance.now() - t0).toFixed(1);
  console.log(`version: ${a}  (probe ${ms}ms)`);
  console.log(bad.length ? "FAILURES:\n" + bad.join("\n") : "GRAPH-VERSION-OK");
  process.exit(bad.length ? 1 : 0);
} finally {
  await pool.end();
}
