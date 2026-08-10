import { WhatsAppShell } from "@/components/whatsapp-shell";
import { stateLabView } from "@/components/whatsapp-state-lab";
import { WhatsAppStateLabShell } from "@/components/whatsapp-state-lab-shell";
import { applicationState } from "@/lib/whatsapp.server";
import { cookies } from "next/headers";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function Home({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly __stateLab?: string }>;
}) {
  const sidebarOpen = (await cookies()).get("sidebar_state")?.value === "true";
  const lab =
    process.env.NODE_ENV === "development"
      ? stateLabView((await searchParams).__stateLab)
      : undefined;
  if (lab) return <WhatsAppStateLabShell initial={lab} sidebarOpen={sidebarOpen} />;

  if (!process.env.WHATSAPPD_PROFILE_DIR || !process.env.WHATSAPPD_ACCOUNT_ID) {
    return (
      <main className="grid min-h-svh place-items-center p-6">
        <div className="max-w-lg rounded-xl border bg-card p-6">
          <h1 className="text-lg font-semibold">WhatsApp account not configured</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Set WHATSAPPD_PROFILE_DIR and WHATSAPPD_ACCOUNT_ID, then restart this local example.
          </p>
        </div>
      </main>
    );
  }

  return <WhatsAppShell initial={await applicationState()} sidebarOpen={sidebarOpen} />;
}
