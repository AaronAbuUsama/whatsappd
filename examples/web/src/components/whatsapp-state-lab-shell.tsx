"use client";

import { useEffect, useState } from "react";
import { WhatsAppShell } from "@/components/whatsapp-shell";
import { whatsappAssetSources } from "@/lib/whatsapp-assets";
import { createStateLabBrowser } from "@/components/whatsapp-state-lab";
import type { WhatsAppApplicationView } from "@/lib/whatsapp-application";

export function WhatsAppStateLabShell({
  initial,
  sidebarOpen,
}: {
  readonly initial: WhatsAppApplicationView;
  readonly sidebarOpen: boolean;
}) {
  const [browser] = useState(() => createStateLabBrowser(initial));
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  return (
    <>
      <WhatsAppShell
        sidebarOpen={sidebarOpen}
        browser={browser}
        assetSources={whatsappAssetSources}
      />
      {ready && <span data-testid="state-lab-ready" hidden />}
    </>
  );
}
