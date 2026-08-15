import { createAuthClient } from "better-auth/react";
import { inferAdditionalFields } from "better-auth/client/plugins";
import type { auth } from "@/lib/auth";

/**
 * Client-side auth. Same-origin: the session cookie rides every fetch
 * automatically, so Chat/GraphView/etc. need no changes.
 *
 *   authClient.signUp.email({ name, email, password })
 *   authClient.signIn.email({ email, password })
 *   authClient.signOut()
 *   authClient.useSession()  → { data: { user, session }, isPending }
 */
export const authClient = createAuthClient({
  plugins: [inferAdditionalFields<typeof auth>()],
});
