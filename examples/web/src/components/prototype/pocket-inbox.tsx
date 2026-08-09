"use client";

import { ChatList, ConversationPanel } from "@/components/prototype/shared";
import { Badge } from "@/components/ui/badge";
import { MessagesSquareIcon, SearchIcon, Settings2Icon, UserRoundIcon } from "lucide-react";

export function PocketInbox() {
  return (
    <main className="mx-auto flex h-svh max-w-6xl overflow-hidden bg-background shadow-2xl lg:my-4 lg:h-[calc(100svh-2rem)] lg:rounded-3xl lg:border">
      <aside className="hidden w-[340px] shrink-0 border-r md:block">
        <ChatList />
      </aside>
      <section className="flex min-w-0 flex-1 flex-col">
        <div className="min-h-0 flex-1">
          <ConversationPanel compact />
        </div>
        <nav
          aria-label="Primary"
          className="grid h-16 grid-cols-4 border-t bg-background md:hidden"
        >
          <MobileNav active icon={<MessagesSquareIcon />} label="Chats" />
          <MobileNav icon={<SearchIcon />} label="Search" />
          <MobileNav icon={<UserRoundIcon />} label="Contacts" />
          <MobileNav icon={<Settings2Icon />} label="Settings" />
        </nav>
      </section>
    </main>
  );
}

function MobileNav({
  label,
  icon,
  active = false,
}: {
  label: string;
  icon: React.ReactNode;
  active?: boolean;
}) {
  return (
    <button
      className="relative flex flex-col items-center justify-center gap-1 text-muted-foreground text-[11px]"
      type="button"
    >
      <span className={active ? "text-foreground" : undefined}>{icon}</span>
      <span className={active ? "font-medium text-foreground" : undefined}>{label}</span>
      {label === "Chats" && (
        <Badge className="absolute top-1.5 left-[55%] size-4 justify-center rounded-full p-0 text-[9px]">
          5
        </Badge>
      )}
    </button>
  );
}
