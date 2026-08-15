"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { authClient } from "@/lib/auth-client";

const INPUT =
  "w-full rounded-xl border border-white/10 bg-white/[0.04] px-4 py-2.5 text-sm text-slate-200 placeholder-slate-500 outline-none transition focus:border-indigo-400/60 focus:bg-white/[0.06]";

export default function SignupPage() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // null = still checking, governed by app_state['signup_enabled'] via /api/settings
  const [enabled, setEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => (r.ok ? r.json() : { signupEnabled: true }))
      .then((d) => setEnabled(d.signupEnabled !== false))
      .catch(() => setEnabled(true)); // fail-open in UI; the API hook is the real gate
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const { error } = await authClient.signUp.email({ name, email, password });
    if (error) {
      setError(error.message ?? "Sign-up failed");
      setBusy(false);
      return;
    }
    window.location.assign("/"); // first account auto-signs in and is admin
  }

  return (
    <main className="relative grid min-h-screen place-items-center overflow-hidden bg-[#05050f] px-4">
      {/* cosmos glow */}
      <div className="pointer-events-none absolute -top-40 left-1/2 h-96 w-96 -translate-x-1/2 rounded-full bg-indigo-600/20 blur-[120px]" />
      <div className="pointer-events-none absolute bottom-0 right-0 h-80 w-80 rounded-full bg-violet-600/15 blur-[120px]" />

      <div className="rise-in w-[380px] max-w-full rounded-3xl border border-white/[0.08] bg-[#0a0a18]/80 p-8 shadow-[0_24px_80px_-12px_rgba(0,0,0,0.85)] backdrop-blur-2xl">
        <div className="mb-7 flex flex-col items-center gap-4 text-center">
          <div className="orb" style={{ width: 56, height: 56 }} />
          <div>
            <h1 className="font-display text-xl font-semibold tracking-tight text-white">
              {enabled === false ? "Sign-ups are closed" : "Create your Sanctum"}
            </h1>
            <p className="mt-1 text-xs text-slate-400">
              {enabled === false
                ? "invite-only right now — ask the admin to open sign-ups"
                : "the first account becomes the admin"}
            </p>
          </div>
        </div>

        {enabled === null && (
          <p className="py-4 text-center text-xs text-slate-500">checking availability…</p>
        )}

        {enabled === false && (
          <p className="text-center text-xs text-slate-500">
            Already have an account?{" "}
            <Link href="/login" className="text-indigo-400 transition hover:text-indigo-300">
              Sign in
            </Link>
          </p>
        )}

        {enabled === true && (
          <>
            <form onSubmit={submit} className="flex flex-col gap-3">
              <input
                type="text"
                required
                autoComplete="name"
                placeholder="Name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className={INPUT}
              />
              <input
                type="email"
                required
                autoComplete="email"
                placeholder="Email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className={INPUT}
              />
              <input
                type="password"
                required
                minLength={8}
                autoComplete="new-password"
                placeholder="Password (8+ characters)"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={INPUT}
              />
              {error && (
                <p className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
                  {error}
                </p>
              )}
              <button
                type="submit"
                disabled={busy}
                className="mt-1 w-full rounded-xl bg-gradient-to-r from-indigo-500 to-violet-600 py-2.5 text-sm font-medium text-white shadow-[0_0_24px_rgba(99,102,241,0.35)] transition hover:brightness-110 active:scale-[0.99] disabled:opacity-50"
              >
                {busy ? "Creating account…" : "Create account"}
              </button>
            </form>

            <p className="mt-5 text-center text-xs text-slate-500">
              Already have an account?{" "}
              <Link href="/login" className="text-indigo-400 transition hover:text-indigo-300">
                Sign in
              </Link>
            </p>
          </>
        )}
      </div>
    </main>
  );
}
