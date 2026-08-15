import pg from "pg";
import fs from "node:fs";
const url = fs.readFileSync(".env", "utf8").match(/DATABASE_URL=["']?([^"'\r\n]+)/)?.[1];
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await c.connect();
const a = await c.query("select value #>> '{}' as current from app_state where key='current_session'");
console.log("current_session:", a.rows[0]?.current);
const s = await c.query(`select id::text, title, swept_count,
  (select count(*) from chat_messages m where m.session_id=s.id)::int as msgs,
  created_at from chat_sessions s order by created_at desc limit 4`);
s.rows.forEach((r) => console.log(JSON.stringify(r)));
const n = await c.query("select name from nodes where name ilike any(array['%fabliha%','%apurba%','%erina%'])");
console.log("recovered nodes:", JSON.stringify(n.rows));
const d = await c.query("select left(raw_text,60) as t, created_at from dumps order by created_at desc limit 3");
d.rows.forEach((r) => console.log(JSON.stringify(r)));
await c.end();
