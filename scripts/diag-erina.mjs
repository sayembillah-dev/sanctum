import pg from "pg";
import fs from "node:fs";

const env = fs.readFileSync(".env", "utf8");
const url = env.match(/DATABASE_URL=["']?([^"'\r\n]+)/)?.[1];
if (!url) { console.error("DATABASE_URL not found in .env"); process.exit(1); }

const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await c.connect();

const q = async (label, sql, params = []) => {
  try {
    const r = await c.query(sql, params);
    console.log("\n== " + label + " (" + r.rows.length + ") ==");
    for (const row of r.rows) console.log(JSON.stringify(row));
  } catch (e) {
    console.log("\n== " + label + " == ERROR: " + e.message);
  }
};

await q("nodes matching Fabliha/Apurba/Erina/Erin",
  `select type, name, attrs::text as attrs, mention_count, created_at::date from nodes
   where name ilike any(array['%fabliha%','%apurba%','%erina%','%erin%'])
      or attrs::text ilike any(array['%fabliha%','%apurba%','%erina%'])`);

await q("Naeem/Fahim node attrs",
  `select name, attrs::text as attrs from nodes where name ilike any(array['%naeem%','%fahim%']) and valid_to is null`);

await q("recent dumps (each remember save = one dump)",
  `select left(raw_text, 90) as text, created_at from dumps order by created_at desc limit 12`);

await q("sessions + message counts",
  `select id::text, title, title_source, created_at,
     (select count(*) from chat_messages m where m.session_id = s.id) as msgs
   from chat_sessions s order by created_at desc limit 5`);

await q("last 14 chat messages",
  `select role, left(content, 70) as text, created_at from chat_messages order by created_at desc limit 14`);

await q("recent edges",
  `select e.type, sn.name as src, dn.name as dst, e.created_at from edges e
   join nodes sn on sn.id = e.src_id join nodes dn on dn.id = e.dst_id
   order by e.created_at desc limit 12`);

await c.end();
