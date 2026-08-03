import { signIn } from "@waypoint/core/auth";

/** The only public page (§4). */
export default function SignInPage() {
  return (
    <main className="flex min-h-full items-center justify-center p-6">
      <div className="w-full max-w-sm rounded-2xl border border-zinc-800 bg-zinc-900/60 p-8 text-center">
        <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-xl bg-indigo-500/20 text-2xl">
          🧭
        </div>
        <h1 className="text-lg font-semibold text-zinc-50">Waypoint</h1>
        <form
          className="mt-6"
          action={async () => {
            "use server";
            await signIn("google", { redirectTo: "/" });
          }}
        >
          <button
            type="submit"
            className="w-full cursor-pointer rounded-lg bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 transition-colors hover:bg-white"
          >
            Sign in with Google
          </button>
        </form>
        <p className="mt-4 text-xs text-zinc-600">Allowlisted accounts only.</p>
      </div>
    </main>
  );
}
