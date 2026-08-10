"use client";

import { useEffect, useState } from "react";
import { WhatsAppShell } from "@/components/whatsapp-shell";
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
      <WhatsAppShell initial={initial} sidebarOpen={sidebarOpen} browser={browser} />
      {ready && <span data-testid="state-lab-ready" hidden />}
    </>
  );
}
