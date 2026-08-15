// Auth smoke test — Phase 1 gate end to end, against a throwaway dev server
// on :3100 and the live DB. Creates a FIRST user (so the admin path is real),
// asserts the whole policy, then CLEANS UP: test users deleted, signup flag row
// removed → DB returns to pristine zero-users state for the real first signup.
import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import pg from "pg";

// minimal .env loader (same approach as migrate.mjs)
const envPath = path.resolve(".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const BASE = "http://localhost:3100";
const EMAIL = "auth-smoke@test.local";

// pristine start: wipe leftovers from any previous run BEFORE signing up,
// so "first user = admin" is exercised for real.
const pre = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
await pre.query(`delete from "user" where email like '%@test.local'`);
await pre.query(`delete from app_state where key = 'signup_enabled'`);
await pre.end();

const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "-p", "3100"], {
  stdio: "ignore",
});
function killServer() {
  try {
    execSync(`taskkill /pid ${server.pid} /t /f`, { stdio: "ignore" });
  } catch {
    /* already dead */
  }
}

let passed = 0,
  failed = 0;
const check = (name, cond) => {
  cond ? passed++ : failed++;
  console.log((cond ? "PASS " : "FAIL ") + name);
};
// better-auth enforces an Origin check on POSTs (CSRF protection). Browsers
// always send Origin; node fetch doesn't — so simulate the canonical origin
// (= BETTER_AUTH_URL) the way a real browser on the deployed URL would.
const post = (url, body, headers = {}) =>
  fetch(BASE + url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://localhost:3000", ...headers },
    body: JSON.stringify(body),
  });

try {
  // wait for the dev server (routes compile on first hit — be patient)
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    up = await fetch(BASE + "/login")
      .then((r) => r.ok)
      .catch(() => false);
  }
  if (!up) throw new Error("dev server never came up on :3100");

  // 1. the gate: pages redirect, APIs 401, without a session cookie
  let r = await fetch(BASE + "/", { redirect: "manual" });
  check(
    "GET / without session redirects to /login",
    (r.status === 307 || r.status === 308) && (r.headers.get("location") || "").includes("/login")
  );
  r = await fetch(BASE + "/api/tasks");
  check("GET /api/tasks without session → 401", r.status === 401);
  r = await fetch(BASE + "/api/graph");
  check("GET /api/graph without session → 401", r.status === 401);
  r = await fetch(BASE + "/api/admin/export");
  check("GET /api/admin/export without session → 401/403", r.status === 401 || r.status === 403);

  // 2. public surface stays public
  r = await fetch(BASE + "/api/settings");
  const settings = await r.json();
  check(
    "GET /api/settings public → { signupEnabled: true }",
    r.status === 200 && settings.signupEnabled === true
  );

  // 3. first signup ever → allowed, session cookie, and isAdmin === true
  r = await post("/api/auth/sign-up/email", {
    name: "Auth Smoke",
    email: EMAIL,
    password: "smoke-test-pass-1",
  });
  const cookies = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  const sessionCookie = cookies.find((c) => c.includes("session_token"));
  const cookie = sessionCookie ? sessionCookie.split(";")[0] : "";
  check("first signup → 200 + session cookie", r.status === 200 && cookie.includes("session_token"));
  r = await fetch(BASE + "/api/auth/get-session", { headers: { cookie } });
  const sess = await r.json();
  check("first user is admin", sess?.user?.isAdmin === true);

  // 4. authenticated API access works
  r = await fetch(BASE + "/api/tasks", { headers: { cookie } });
  check("GET /api/tasks with session → 200", r.status === 200);
  r = await fetch(BASE + "/", { headers: { cookie }, redirect: "manual" });
  check("GET / with session → 200", r.status === 200);

  // 5. admin flips signup off → new signups blocked at the API level
  r = await post("/api/settings", { signupEnabled: false }, { cookie });
  check("admin POST /api/settings { signupEnabled: false } → 200", r.status === 200);
  r = await fetch(BASE + "/api/settings");
  check("settings now report signupEnabled: false", (await r.json()).signupEnabled === false);
  r = await post("/api/auth/sign-up/email", {
    name: "Blocked",
    email: "blocked@test.local",
    password: "smoke-test-pass-1",
  });
  check("signup while disabled → 403", r.status === 403);
  await post("/api/settings", { signupEnabled: true }, { cookie });

  // 6. non-admin cannot touch the settings switch (no second user exists, so
  //    verify the guard negatively: no cookie → 401)
  r = await post("/api/settings", { signupEnabled: false });
  check("POST /api/settings without session → 401", r.status === 401);

  // 7. sign-in flow
  r = await post("/api/auth/sign-in/email", { email: EMAIL, password: "smoke-test-pass-1" });
  check("sign-in with correct password → 200", r.status === 200);
  r = await post("/api/auth/sign-in/email", { email: EMAIL, password: "wrong-password-9" });
  check("sign-in with wrong password → 401", r.status === 401);
} catch (e) {
  failed++;
  console.error("ERROR:", e instanceof Error ? e.message : e);
} finally {
  killServer();
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  try {
    await pool.query(`delete from "user" where email like '%@test.local'`); // cascades session/account
    await pool.query(`delete from app_state where key = 'signup_enabled'`); // back to default-enabled
  } finally {
    await pool.end();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
