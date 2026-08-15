"use client";

import { useEffect, useState } from "react";
import { authClient } from "@/lib/auth-client";

/** Account bubble in the chat header: glass modal with the signed-in profile,
 *  the admin-only "allow new sign-ups" switch, the opt-in markdown-mirror
 *  switch (file-over-app write-through), admin data exports (Obsidian vault
 *  zip / full JSON backup), and sign out. */
export default function UserMenu() {
  const { data: session, isPending } = authClient.useSession();
  const [open, setOpen] = useState(false);
  const [signupEnabled, setSignupEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [mirrorEnabled, setMirrorEnabled] = useState<boolean | null>(null);
  const [savingMirror, setSavingMirror] = useState(false);
  const [exporting, setExporting] = useState<"vault" | "json" | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  const user = session?.user as { name?: string; email?: string; isAdmin?: boolean } | undefined;
  const isAdmin = user?.isAdmin === true;

  useEffect(() => {
    if (!open || !isAdmin) return;
    fetch("/api/settings")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) return;
        setSignupEnabled(d.signupEnabled !== false);
        setMirrorEnabled(d.mirrorEnabled === true);
      })
      .catch(() => {});
  }, [open, isAdmin]);

  async function toggleSignup(next: boolean) {
    setSignupEnabled(next); // optimistic
    setSaving(true);
    try {
      const r = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signupEnabled: next }),
      });
      if (!r.ok) setSignupEnabled(!next); // revert
    } catch {
      setSignupEnabled(!next);
    } finally {
      setSaving(false);
    }
  }

  async function toggleMirror(next: boolean) {
    setMirrorEnabled(next); // optimistic
    setSavingMirror(true);
    try {
      const r = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mirrorEnabled: next }),
      });
      if (!r.ok) setMirrorEnabled(!next); // revert
    } catch {
      setMirrorEnabled(!next);
    } finally {
      setSavingMirror(false);
    }
  }

  /** Downloads an admin export via fetch + object URL so we can show a busy
   *  state (the vault build can take a few seconds) and surface errors inline.
   *  The routes send Content-Disposition: attachment, so this never navigates. */
  async function downloadExport(kind: "vault" | "json") {
    setExporting(kind);
    setExportError(null);
    try {
      const url = kind === "vault" ? "/api/admin/export?format=vault" : "/api/admin/export";
      const r = await fetch(url);
      if (!r.ok) throw new Error(`Export failed (HTTP ${r.status})`);
      const blob = await r.blob();
      const m = /filename="?([^";]+)"?/.exec(r.headers.get("Content-Disposition") || "");
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = m?.[1] || (kind === "vault" ? "sanctum-vault.zip" : "sanctum-export.json");
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      setExportError(e instanceof Error ? e.message : "Export failed");
    } finally {
      setExporting(null);
    }
  }

  async function logout() {
    await authClient.signOut().catch(() => {});
    window.location.assign("/login");
  }

  if (isPending || !user) return null;
  const initial = (user.name || user.email || "?").trim().slice(0, 1).toUpperCase();

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title={user.email || "Account"}
        className="grid h-8 w-8 flex-none place-items-center rounded-full bg-gradient-to-br from-indigo-500 to-violet-600 text-xs font-semibold text-white shadow-[0_0_16px_rgba(99,102,241,0.45)] transition hover:brightness-110"
      >
        {initial}
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-black/60 backdrop-blur-sm"
          onClick={() => setOpen(false)}
        >
          <div
            className="rise-in w-[340px] max-w-[calc(100vw-2rem)] rounded-3xl border border-white/[0.08] bg-[#0a0a18]/90 p-6 shadow-[0_24px_80px_-12px_rgba(0,0,0,0.85)] backdrop-blur-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3">
              <div className="grid h-11 w-11 flex-none place-items-center rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 text-base font-semibold text-white">
                {initial}
              </div>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-white">
                  {user.name || "Sanctum user"}
                  {isAdmin && (
                    <span className="ml-2 rounded-full border border-indigo-400/30 bg-indigo-500/15 px-2 py-0.5 align-middle text-[10px] font-medium tracking-wide text-indigo-300">
                      ADMIN
                    </span>
                  )}
                </p>
                <p className="truncate text-xs text-slate-400">{user.email}</p>
              </div>
            </div>

            {isAdmin && (
              <div className="mt-5 rounded-2xl border border-white/[0.06] bg-white/[0.03] p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm text-slate-200">Allow new sign-ups</p>
                    <p className="mt-0.5 text-[11px] leading-snug text-slate-500">
                      Off = /signup closes and no new accounts can be created.
                    </p>
                  </div>
                  <button
                    role="switch"
                    aria-checked={signupEnabled === true}
                    disabled={signupEnabled === null || saving}
                    onClick={() => toggleSignup(signupEnabled !== true)}
                    className={`relative h-5 w-9 flex-none rounded-full transition ${
                      signupEnabled ? "bg-indigo-500" : "bg-white/10"
                    } disabled:opacity-50`}
                  >
                    <span
                      className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${
                        signupEnabled ? "left-[18px]" : "left-0.5"
                      }`}
                    />
                  </button>
                </div>

                <div className="mt-4 flex items-center justify-between gap-3 border-t border-white/[0.06] pt-4">
                  <div>
                    <p className="text-sm text-slate-200">Markdown mirror</p>
                    <p className="mt-0.5 text-[11px] leading-snug text-slate-500">
                      Write new dumps through to mirror/ as plain-text day files;
                      enabling also backfills the past ones. Off = database only
                      (existing files stay).
                    </p>
                  </div>
                  <button
                    role="switch"
                    aria-checked={mirrorEnabled === true}
                    disabled={mirrorEnabled === null || savingMirror}
                    onClick={() => toggleMirror(mirrorEnabled !== true)}
                    className={`relative h-5 w-9 flex-none rounded-full transition ${
                      mirrorEnabled ? "bg-indigo-500" : "bg-white/10"
                    } disabled:opacity-50`}
                  >
                    <span
                      className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${
                        mirrorEnabled ? "left-[18px]" : "left-0.5"
                      }`}
                    />
                  </button>
                </div>

                <div className="mt-4 border-t border-white/[0.06] pt-4">
                  <p className="text-sm text-slate-200">Export data</p>
                  <p className="mt-0.5 text-[11px] leading-snug text-slate-500">
                    Vault = Obsidian-ready markdown notes. JSON = full raw backup.
                  </p>
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <button
                      disabled={exporting !== null}
                      onClick={() => downloadExport("vault")}
                      className="rounded-xl border border-white/10 bg-white/[0.04] py-1.5 text-xs text-slate-300 transition hover:border-indigo-400/40 hover:bg-indigo-500/10 hover:text-indigo-200 disabled:opacity-50"
                    >
                      {exporting === "vault" ? "Building..." : "Vault (.zip)"}
                    </button>
                    <button
                      disabled={exporting !== null}
                      onClick={() => downloadExport("json")}
                      className="rounded-xl border border-white/10 bg-white/[0.04] py-1.5 text-xs text-slate-300 transition hover:border-indigo-400/40 hover:bg-indigo-500/10 hover:text-indigo-200 disabled:opacity-50"
                    >
                      {exporting === "json" ? "Exporting..." : "JSON"}
                    </button>
                  </div>
                  {exportError && (
                    <p className="mt-2 text-[11px] leading-snug text-rose-300">{exportError}</p>
                  )}
                </div>
              </div>
            )}

            <button
              onClick={logout}
              className="mt-5 w-full rounded-xl border border-white/10 bg-white/[0.04] py-2 text-sm text-slate-300 transition hover:border-rose-400/40 hover:bg-rose-500/10 hover:text-rose-200"
            >
              Sign out
            </button>
          </div>
        </div>
      )}
    </>
  );
}
