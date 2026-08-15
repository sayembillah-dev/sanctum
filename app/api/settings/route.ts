import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

const SIGNUP_KEY = "signup_enabled";

/** GET /api/settings — PUBLIC (the /signup page reads it before login).
 *  Returns only non-sensitive flags. */
export async function GET() {
  const flag = await prisma.appState.findUnique({ where: { key: SIGNUP_KEY } });
  return Response.json({ signupEnabled: flag ? flag.value !== false : true });
}

/** POST /api/settings — { signupEnabled: boolean }. ADMIN only. */
export async function POST(req: Request) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (!user.isAdmin) return Response.json({ error: "admin only" }, { status: 403 });

  const body = await req.json().catch(() => null);
  if (typeof body?.signupEnabled !== "boolean") {
    return Response.json({ error: "signupEnabled (boolean) required" }, { status: 400 });
  }
  await prisma.appState.upsert({
    where: { key: SIGNUP_KEY },
    update: { value: body.signupEnabled },
    create: { key: SIGNUP_KEY, value: body.signupEnabled },
  });
  return Response.json({ ok: true, signupEnabled: body.signupEnabled });
}
