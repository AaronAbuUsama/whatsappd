"use client";

import { useEffect, useState } from "react";
import { createWhatsAppBindings } from "@whatsappd/react";
import { toast } from "sonner";
import { WhatsAppChatList } from "@/components/whatsapp-chat-list";
import { WhatsAppConversation } from "@/components/whatsapp-conversation";
import { WhatsAppDirectoryDetail } from "@/components/whatsapp-directory-detail";
import {
  WhatsAppMobileNavigation,
  WhatsAppNavigation,
  type WhatsAppSection,
} from "@/components/whatsapp-navigation";
import { WhatsAppSettings } from "@/components/whatsapp-settings";
import { WhatsAppUpdates } from "@/components/whatsapp-updates";
import { Badge } from "@/components/ui/badge";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { Spinner } from "@/components/ui/spinner";
import { WhatsAppAssetProvider, type WhatsAppAssetSources } from "@/lib/whatsappd/whatsapp-assets";
import type { WhatsAppBrowser, WhatsAppBrowserSnapshot } from "@/lib/whatsappd/web-contract";

const { WhatsAppProvider, useWhatsAppSnapshot, useWhatsAppStore } = createWhatsAppBindings<
  WhatsAppBrowserSnapshot,
  WhatsAppBrowser
>();

export function WhatsAppShell({
  browser,
  sidebarOpen = false,
  assetSources,
}: {
  readonly browser: WhatsAppBrowser;
  readonly sidebarOpen?: boolean;
  readonly assetSources?: WhatsAppAssetSources;
}) {
  return (
    <WhatsAppAssetProvider sources={assetSources}>
      <WhatsAppProvider store={browser}>
        <WhatsAppShellContent sidebarOpen={sidebarOpen} />
      </WhatsAppProvider>
    </WhatsAppAssetProvider>
  );
}

function WhatsAppShellContent({ sidebarOpen }: { readonly sidebarOpen: boolean }) {
  const browser = useWhatsAppStore();
  const { view, selected, pending, error } = useWhatsAppSnapshot();
  const [section, setSection] = useState<WhatsAppSection>("chats");
  useEffect(() => {
    if (error) toast.error(error);
  }, [error]);
  const changeSection = (next: WhatsAppSection): void => {
    setSection(next);
    void browser.select();
  };
  const openChat = (key: string): void => {
    setSection("chats");
    void browser.select(key);
  };
  const openGroup = (key: string): void => {
    setSection("groups");
    void browser.select(key);
  };
  const directory =
    section === "updates" ? (
      <WhatsAppUpdates
        view={view}
        navigation={<WhatsAppMobileNavigation section={section} setSection={changeSection} />}
      />
    ) : section === "settings" ? (
      <WhatsAppSettings
        view={view}
        navigation={<WhatsAppMobileNavigation section={section} setSection={changeSection} />}
      />
    ) : (
      <WhatsAppChatList
        key={section}
        browser={browser}
        view={view}
        section={section}
        setSection={changeSection}
      />
    );
  const detail =
    section === "contacts" || section === "groups" ? (
      <WhatsAppDirectoryDetail
        browser={browser}
        view={view}
        section={section}
        selected={selected}
        openChat={openChat}
        openGroup={openGroup}
      />
    ) : (
      <WhatsAppConversation browser={browser} view={view} />
    );
  const standalone = section === "updates" || section === "settings";
  return (
    <SidebarProvider defaultOpen={sidebarOpen}>
      <div className="hidden md:block">
        <WhatsAppNavigation section={section} setSection={changeSection} />
      </div>
      <SidebarInset className="min-w-0 overflow-hidden">
        {pending > 0 && (
          <div className="fixed top-2 right-2 z-50">
            <Badge>
              <Spinner />
              Working
            </Badge>
          </div>
        )}
        {standalone ? (
          directory
        ) : (
          <div className="grid h-svh min-w-0 md:grid-cols-[minmax(17.5rem,22.5rem)_minmax(0,1fr)]">
            <div className={selected ? "hidden min-w-0 border-r md:block" : "min-w-0 border-r"}>
              {directory}
            </div>
            <div className={selected ? "min-w-0" : "hidden min-w-0 md:block"}>{detail}</div>
          </div>
        )}
      </SidebarInset>
    </SidebarProvider>
  );
}
