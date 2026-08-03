import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import { db } from "./db";

/**
 * Google OAuth via Auth.js v5, JWT sessions, no DB adapter (§4).
 * The allowlist is checked at sign-in here and re-checked per request in
 * apps/web/proxy.ts, so removing an AllowedEmail revokes access immediately
 * despite JWT sessions. The User row is upserted for attribution only.
 */
export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    }),
  ],
  session: { strategy: "jwt" },
  trustHost: true,
  pages: { signIn: "/signin" },
  callbacks: {
    async signIn({ user }) {
      if (!user.email) return false;
      const allowed = await db.allowedEmail.findUnique({ where: { email: user.email } });
      if (!allowed) return false;
      const u = await db.user.upsert({
        where: { email: user.email },
        update: { name: user.name ?? null, image: user.image ?? null },
        create: { email: user.email, name: user.name ?? null, image: user.image ?? null },
      });
      user.id = u.id; // flows into the jwt callback
      return true;
    },
    async jwt({ token, user }) {
      if (user) token.uid = user.id;
      return token;
    },
    async session({ session, token }) {
      session.user.id = token.uid as string;
      return session;
    },
  },
});
