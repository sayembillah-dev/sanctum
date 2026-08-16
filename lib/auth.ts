import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { APIError } from "better-auth/api";
import { headers } from "next/headers";
import { prisma } from "@/lib/db";

/**
 * Sanctum auth — better-auth on top of our own Postgres (sessions in Neon,
 * next to the brain; no external provider).
 *
 * Signup policy (user.create.before hook):
 *   - the FIRST account ever is always allowed and always becomes admin
 *   - after that, signups are governed by app_state['signup_enabled']
 *     (default: enabled; the admin flips it from the account menu in the UI)
 */
export const auth = betterAuth({
  appName: "Sanctum",
  database: prismaAdapter(prisma, { provider: "postgresql" }),
  emailAndPassword: { enabled: true, minPasswordLength: 8 },
  // Round-2 opt B5: cache the session in a signed cookie so getSession()
  // doesn't hit Neon on every request (chat polls, graph probes, page loads).
  // Caveat: admin-flag flips take up to maxAge to propagate.
  session: { cookieCache: { enabled: true, maxAge: 300 } },
  user: {
    additionalFields: {
      // client can never set this (input: false) — only the hook below does
      isAdmin: { type: "boolean", defaultValue: false, input: false },
    },
  },
  databaseHooks: {
    user: {
      create: {
        before: async (user) => {
          const userCount = await prisma.user.count();
          if (userCount === 0) {
            return { data: { ...user, isAdmin: true } }; // first account = admin
          }
          const flag = await prisma.appState.findUnique({ where: { key: "signup_enabled" } });
          const signupEnabled = flag ? flag.value !== false : true;
          if (!signupEnabled) {
            throw new APIError("FORBIDDEN", { message: "Sign-ups are currently closed." });
          }
          return { data: user };
        },
      },
    },
  },
});

/** The session user as Sanctum sees it (better-auth user + our isAdmin flag). */
export interface SanctumUser {
  id: string;
  name: string;
  email: string;
  isAdmin: boolean;
}

/** Server-side session lookup for route handlers. null = not signed in. */
export async function getSessionUser(): Promise<SanctumUser | null> {
  const session = await auth.api.getSession({ headers: await headers() });
  return (session?.user as unknown as SanctumUser) ?? null;
}

export const requireUser = getSessionUser;

/** Admin gate for /api/admin/* (except cron-guarded consolidate). null = reject. */
export async function requireAdmin(): Promise<SanctumUser | null> {
  const user = await getSessionUser();
  return user?.isAdmin ? user : null;
}
