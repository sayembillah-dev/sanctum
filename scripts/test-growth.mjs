// Smoke test for the Grows-With-You loops. Run with dev server up: node scripts/test-growth.mjs
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

console.log("→ POST /api/chat (message contains user preferences + a task with a deadline)…");
const res = await fetch("http://localhost:3001/api/chat", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    messages: [
      {
        role: "user",
        content:
          "Hey Sanctum — quick notes: I prefer short, direct answers, and I've started running every morning before work. Also Emran said the sign-in API fix is due this Friday.",
      },
    ],
  }),
});
const reply = await res.text();
console.log("← reply:", reply.slice(0, 280), "\n");
console.log("recalled nodes header:", res.headers.get("X-Recalled-Nodes"));

console.log("⏳ waiting 15s for silent extraction to land…");
await new Promise((r) => setTimeout(r, 15000));

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const { rows } = await pool.query(
  "select name, type, pinned, mention_count, attrs from nodes where valid_to is null order by pinned desc, created_at desc limit 10"
);
console.log("\n🧠 live nodes:");
for (const r of rows) {
  console.log(`  ${r.pinned ? "☀️" : "•"} ${r.name} [${r.type}] mentions=${r.mention_count}`);
  if (r.pinned) console.log("     attrs:", JSON.stringify(r.attrs));
}
const edges = await pool.query(
  "select count(*)::int as c from edges where valid_to is null"
);
console.log("  synapses:", edges.rows[0].c);
await pool.end();
