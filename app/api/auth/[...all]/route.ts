import { auth } from "@/lib/auth";
import { toNextJsHandler } from "better-auth/next-js";

// better-auth owns everything under /api/auth/* — sign-up/email, sign-in/email,
// sign-out, get-session, … The signup policy (first-user-admin + the
// signup_enabled flag) is enforced by the database hook in lib/auth.ts.
export const { GET, POST } = toNextJsHandler(auth.handler);
