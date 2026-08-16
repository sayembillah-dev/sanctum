// B5 smoke (non-destructive): boot a throwaway dev server on :3100 with the
// cookieCache config live, then prove the auth stack works — /login renders,
// better-auth answers a session query, and a bad login is rejected (not a 500).
// Unlike test-auth.mjs this NEVER writes to the DB (no users created/deleted).
import { spawn, execSync } from "node:child_process";

const BASE = "http://localhost:3100";
const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "-p", "3100"], { stdio: "ignore" });
const killServer = () => {
  try {
    execSync(`taskkill /pid ${server.pid} /t /f`, { stdio: "ignore" });
  } catch {}
};
process.on("exit", killServer);

const waitReady = async () => {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/login`, { signal: AbortSignal.timeout(2000) });
      if (r.status) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
};

let passed = 0, failed = 0;
const check = (name, cond) => {
  console.log(`${cond ? "✅" : "❌"} ${name}`);
  cond ? passed++ : failed++;
};

try {
  check("server boots with cookieCache config", await waitReady());

  const loginPage = await fetch(`${BASE}/login`);
  check("/login renders (200)", loginPage.status === 200);

  const sess = await fetch(`${BASE}/api/auth/session`);
  check("GET /api/auth/session answers (not 5xx)", sess.status < 500);

  const bad = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "nobody@nowhere.invalid", password: "wrong-password-123" }),
  });
  check("bad login rejected (4xx, not crash)", bad.status >= 400 && bad.status < 500);
} catch (e) {
  console.error("smoke error:", e.message);
  failed++;
} finally {
  killServer();
}
console.log(failed ? `AUTH-BOOT FAIL (${failed})` : `AUTH-BOOT-OK (${passed} checks)`);
process.exit(failed ? 1 : 0);
