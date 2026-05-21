import Image from "next/image";
import Link from "next/link";

// Pinned to the current release. Bump on each tagged release.
// (A version-less /api/download/[platform] route would avoid this,
// but a hardcoded URL is fine while we ship infrequently.)
const MACOS_DMG_URL =
  "https://github.com/OpenAdminOS/OpenAdminOS/releases/download/v0.1.8/OpenAdminOS-0.1.8-arm64.dmg";
const CURRENT_VERSION = "v0.1.8";

export default function HomePage() {
  return (
    <div className="relative flex min-h-screen flex-col bg-[#0a0a0c] text-white">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[600px] bg-[radial-gradient(ellipse_at_top,rgba(140,140,255,0.10),transparent_70%)]"
      />

      <header className="relative z-10 flex items-center px-6 py-6 sm:px-10">
        <Link href="/" className="text-sm font-semibold tracking-tight">
          OpenAdminOS
        </Link>
      </header>

      <main className="relative z-10 flex flex-1 flex-col items-center px-6 sm:px-10">
        <div className="flex flex-col items-center pt-10 text-center sm:pt-14">
          <Link
            href={`https://github.com/OpenAdminOS/OpenAdminOS/releases/tag/${CURRENT_VERSION}`}
            target="_blank"
            rel="noreferrer"
            className="mb-5 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs font-medium uppercase tracking-wider text-white/70 transition hover:border-white/20 hover:text-white"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
            {CURRENT_VERSION} — release notes
          </Link>

          <h1 className="max-w-3xl text-balance text-4xl font-semibold tracking-tight sm:text-5xl">
            Open-source, local-first agents for Microsoft 365 admins.
          </h1>

          <p className="mt-4 max-w-2xl text-balance text-base text-white/60 sm:text-lg">
            Connect a tenant, pick a local LLM, run read-only agents against
            Intune and Entra. Tenant data and prompts stay on your machine.
          </p>

          <div className="mt-8 flex flex-col items-center gap-3 sm:flex-row">
            <a
              href={MACOS_DMG_URL}
              className="inline-flex items-center gap-2 rounded-lg bg-white px-5 py-2.5 text-sm font-semibold text-[#0a0a0c] shadow-[0_8px_30px_-4px_rgba(255,255,255,0.25)] transition hover:bg-white/90"
            >
              <svg
                aria-hidden
                viewBox="0 0 384 512"
                className="h-4 w-4 fill-current"
              >
                <path d="M318.7 268.7c-.2-36.7 16.4-64.4 50-84.8-18.8-26.9-47.2-41.7-84.7-44.6-35.5-2.8-74.3 20.7-88.5 20.7-15 0-49.4-19.7-76.4-19.7C63.3 141.2 4 184.8 4 273.5q0 39.3 14.4 81.2c12.8 36.7 59 126.7 107.2 125.2 25.2-.6 43-17.9 75.8-17.9 31.8 0 48.3 17.9 76.4 17.9 48.6-.7 90.4-82.5 102.6-119.3-65.2-30.7-61.7-90-61.7-91.9zM256.6 105.8c30.3-36 27.6-68.8 26.7-80.6-26.8 1.6-57.8 18.3-75.5 38.8-19.5 22-31 49.2-28.5 80 29 2.2 55.5-12.7 77.3-38.2z" />
              </svg>
              Download for macOS
            </a>
            <button
              type="button"
              disabled
              aria-disabled="true"
              title="Windows build is unsigned right now; coming after Microsoft Store signing lands."
              className="inline-flex cursor-not-allowed items-center gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-5 py-2.5 text-sm font-medium text-white/40"
            >
              <svg
                aria-hidden
                viewBox="0 0 448 512"
                className="h-4 w-4 fill-current"
              >
                <path d="M0 93.7l183.6-25.3v177.4H0V93.7zm0 324.6l183.6 25.3V268.4H0v149.9zm203.8 28L448 480V268.4H203.8v177.9zm0-380.6v180.1H448V32L203.8 65.7z" />
              </svg>
              Download for Windows
              <span className="ml-1 text-[10px] font-normal uppercase tracking-wider text-white/30">
                Soon
              </span>
            </button>
          </div>

          <p className="mt-3 text-[11.5px] text-white/40">
            Free and open-source. MIT licensed.{" "}
            <Link
              href="https://github.com/OpenAdminOS/OpenAdminOS"
              target="_blank"
              rel="noreferrer"
              className="underline-offset-4 hover:text-white/70 hover:underline"
            >
              github.com/OpenAdminOS/OpenAdminOS
            </Link>
          </p>
        </div>

        <div className="mt-12 w-full max-w-[88rem] pb-16 sm:mt-16">
          <div className="relative overflow-hidden rounded-xl border border-white/10 bg-white/[0.02] shadow-[0_40px_160px_-20px_rgba(140,140,255,0.3)] sm:rounded-2xl">
            <Image
              src="/openadminos-app.png"
              alt="OpenAdminOS app showing agent runs across Intune-managed devices"
              width={2400}
              height={1500}
              priority
              sizes="(min-width: 1408px) 1408px, 100vw"
              className="h-auto w-full"
            />
          </div>
        </div>
      </main>

      <footer className="relative z-10 flex flex-col items-center gap-2 px-6 py-8 text-center sm:px-10">
        <span className="text-xs text-white/40">
          © {new Date().getFullYear()}{" "}
          <Link
            href="https://openadminos.com"
            target="_blank"
            rel="noreferrer"
            className="underline-offset-4 transition hover:text-white/70 hover:underline"
          >
            OpenAdminOS
          </Link>
          {" · "}
          <Link
            href="/privacy"
            className="underline-offset-4 transition hover:text-white/70 hover:underline"
          >
            Privacy
          </Link>
          {" · "}
          <Link
            href="/terms"
            className="underline-offset-4 transition hover:text-white/70 hover:underline"
          >
            Terms
          </Link>
        </span>
      </footer>
    </div>
  );
}
