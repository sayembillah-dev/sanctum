import pg from "pg";
import fs from "node:fs";
const url = fs.readFileSync(".env", "utf8").match(/DATABASE_URL=["']?([^"'\r\n]+)/)?.[1];
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await c.connect();
const q = async (label, sql) => {
  const r = await c.query(sql);
  console.log("\n== " + label + " (" + r.rows.length + ") ==");
  r.rows.forEach((row) => console.log(JSON.stringify(row)));
};
await q("Revoo/EV/bike nodes", `select type, name, attrs::text from nodes
  where name ilike any(array['%revoo%','%bike%','%ev%','%scooter%']) or attrs::text ilike any(array['%revoo%','%ev bike%'])`);
await q("profile attrs (Sayem)", `select attrs::text from nodes where type='Profile' and valid_to is null`);
await q("Kacchi nodes + types", `select type, name, attrs::text from nodes where name ilike '%kacchi%'`);
await q("recent tasks", `select title, status, due_at, created_at from tasks order by created_at desc limit 8`);
await q("dumps mentioning Revoo (did remember fire?)", `select left(raw_text,70) as t, created_at from dumps where raw_text ilike '%revoo%' order by created_at desc limit 5`);
await q("edges around Kacchi", `select e.type, sn.name as src, dn.name as dst from edges e
  join nodes sn on sn.id=e.src_id join nodes dn on dn.id=e.dst_id
  where sn.name ilike '%kacchi%' or dn.name ilike '%kacchi%'`);
await c.end();
