"use client";

import { useState } from "react";
import { WhatsAppShell } from "@/components/whatsapp-shell";
import { whatsappAssetSources } from "@/lib/whatsapp-assets";
import { createWhatsAppBrowser } from "@/lib/whatsapp-browser";
import type { WhatsAppApplicationView } from "@/lib/whatsappd/web-contract";

export function WhatsAppBrowserShell({
  initial,
  sidebarOpen,
}: {
  readonly initial: WhatsAppApplicationView;
  readonly sidebarOpen: boolean;
}) {
  const [browser] = useState(() => createWhatsAppBrowser(initial));
  return (
    <WhatsAppShell
      browser={browser}
      sidebarOpen={sidebarOpen}
      assetSources={whatsappAssetSources}
    />
  );
}
