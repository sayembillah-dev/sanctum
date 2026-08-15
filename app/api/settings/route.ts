import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { buildVault } from "@/lib/mirror";

export const dynamic = "force-dynamic";

const SIGNUP_KEY = "signup_enabled";
const MIRROR_KEY = "mirror_enabled";

/** GET /api/settings — PUBLIC (the /signup page reads it before login).
 *  Returns only non-sensitive flags. */
export async function GET() {
  const [signup, mirror] = await Promise.all([
    prisma.appState.findUnique({ where: { key: SIGNUP_KEY } }),
    prisma.appState.findUnique({ where: { key: MIRROR_KEY } }),
  ]);
  return Response.json({
    signupEnabled: signup ? signup.value !== false : true,
    mirrorEnabled: mirror?.value === true, // opt-in: absent = off
  });
}

/** POST /api/settings — { signupEnabled?: boolean, mirrorEnabled?: boolean }.
 *  ADMIN only. Enabling the mirror backfills the whole vault from the DB
 *  (best-effort, fire-and-forget) so dumps from before the toggle land too. */
export async function POST(req: Request) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (!user.isAdmin) return Response.json({ error: "admin only" }, { status: 403 });

  const body = await req.json().catch(() => null);
  const hasSignup = typeof body?.signupEnabled === "boolean";
  const hasMirror = typeof body?.mirrorEnabled === "boolean";
  if (!hasSignup && !hasMirror) {
    return Response.json(
      { error: "signupEnabled and/or mirrorEnabled (boolean) required" },
      { status: 400 }
    );
  }
  if (hasSignup) {
    await prisma.appState.upsert({
      where: { key: SIGNUP_KEY },
      update: { value: body.signupEnabled },
      create: { key: SIGNUP_KEY, value: body.signupEnabled },
    });
  }
  if (hasMirror) {
    await prisma.appState.upsert({
      where: { key: MIRROR_KEY },
      update: { value: body.mirrorEnabled },
      create: { key: MIRROR_KEY, value: body.mirrorEnabled },
    });
    if (body.mirrorEnabled) {
      buildVault().catch((e) => console.warn("🪞 mirror backfill failed:", e));
    }
  }
  return Response.json({
    ok: true,
    signupEnabled: body.signupEnabled,
    mirrorEnabled: body.mirrorEnabled,
  });
}
