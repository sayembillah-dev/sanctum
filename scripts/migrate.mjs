// Sanctum auto-migrator — runs before `next dev`/`build`.
// Applies any new db/migrations/*.sql in order, tracked in a `_migrations` table.
// No DATABASE_URL? Warns and skips gracefully (so builds without env don't break).
import fs from "node:fs";
import path from "node:path";
import pg from "pg";

// Minimal .env loader (no dotenv dependency)
const envPath = path.resolve(".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

if (!process.env.DATABASE_URL) {
  console.warn("⚠️  DATABASE_URL not set — skipping migrations (add it to .env)");
  process.exit(0);
}

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const client = await pool.connect();
try {
  await client.query(
    `create table if not exists _migrations (name text primary key, applied_at timestamptz not null default now())`
  );
  const applied = new Set((await client.query(`select name from _migrations`)).rows.map((r) => r.name));

  const dir = path.resolve("db/migrations");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();

  let ran = 0;
  for (const f of files) {
    if (applied.has(f)) continue;
    console.log(`⏳ Applying ${f}…`);
    await client.query("begin");
    try {
      await client.query(fs.readFileSync(path.join(dir, f), "utf8"));
      await client.query(`insert into _migrations (name) values ($1)`, [f]);
      await client.query("commit");
      console.log(`✅ ${f}`);
      ran++;
    } catch (err) {
      await client.query("rollback");
      throw err;
    }
  }
  console.log(ran ? `✅ ${ran} migration(s) applied` : "✅ Schema already up to date");
} finally {
  client.release();
  await pool.end();
}
