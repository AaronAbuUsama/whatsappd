"use client";

import { useMemo, useState } from "react";
import { CheckCheckIcon, CheckIcon, CircleAlertIcon, SearchIcon } from "lucide-react";
import { WhatsAppAvatar } from "@/components/whatsapp-avatar";
import { WhatsAppGroupCreate } from "@/components/whatsapp-groups";
import { WhatsAppMobileNavigation, type WhatsAppSection } from "@/components/whatsapp-navigation";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { ScrollArea } from "@/components/ui/scroll-area";
import type {
  ApplicationChat,
  WhatsAppApplicationView,
  WhatsAppBrowser,
} from "@/lib/whatsappd/web-contract";

const sameDay = (left: number, right: number): boolean => {
  const a = new Date(left);
  const b = new Date(right);
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
};
const listTime = (timestamp: number): string => {
  const now = Date.now();
  if (sameDay(timestamp, now))
    return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(
      timestamp,
    );
  if (sameDay(timestamp, now - 86_400_000)) return "Yesterday";
  return new Intl.DateTimeFormat(undefined, {
    month: "numeric",
    day: "numeric",
    year: "2-digit",
  }).format(timestamp);
};

type ListEntry = Pick<ApplicationChat, "key" | "name" | "initials" | "avatar" | "canSend"> & {
  readonly description?: string;
  readonly lastMessageAt?: number;
  readonly previewFromMe?: boolean;
  readonly previewReceipt?: ApplicationChat["previewReceipt"];
  readonly searchNames?: readonly string[];
};

function PreviewReceipt({ status }: { readonly status: ApplicationChat["previewReceipt"] }) {
  if (!status) return null;
  if (status === "delivered" || status === "read" || status === "played")
    return <CheckCheckIcon className="size-3.5 shrink-0" aria-label={status} />;
  if (status === "error")
    return <CircleAlertIcon className="size-3.5 shrink-0 text-destructive" aria-label="error" />;
  return <CheckIcon className="size-3.5 shrink-0" aria-label={status} />;
}

export function WhatsAppChatList({
  browser,
  view,
  section,
  setSection,
}: {
  readonly browser: WhatsAppBrowser;
  readonly view: WhatsAppApplicationView;
  readonly section: WhatsAppSection;
  readonly setSection: (section: WhatsAppSection) => void;
}) {
  const [query, setQuery] = useState("");
  const entries = useMemo<readonly ListEntry[]>(() => {
    if (section === "contacts")
      return view.contacts.map((contact) => ({
        ...contact,
        description: contact.presence ?? contact.about,
        searchNames: contact.names.map(({ value }) => value),
      }));
    if (section === "groups")
      return view.groups.map((group) => ({
        ...group,
        description:
          group.participantCount === undefined
            ? "Participants not loaded"
            : `${group.participantCount} participant${group.participantCount === 1 ? "" : "s"}`,
      }));
    return view.chats.map((chat) => ({
      ...chat,
      description: chat.preview ?? (chat.isGroup ? "Group" : "Conversation"),
    }));
  }, [section, view]);
  const normalized = query.trim().toLocaleLowerCase();
  const filtered = normalized
    ? entries.filter((entry) =>
        [entry.name, entry.description, ...(entry.searchNames ?? [])].some((value) =>
          value?.toLocaleLowerCase().includes(normalized),
        ),
      )
    : entries;
  return (
    <section className="flex h-svh min-w-0 flex-col">
      <WhatsAppMobileNavigation section={section} setSection={setSection} />
      <header className="border-b px-4 py-3">
        <div className="mb-3 flex items-center justify-between">
          <h1 className="text-2xl font-semibold md:text-lg">
            {section[0]!.toUpperCase() + section.slice(1)}
          </h1>
          {section === "groups" && <WhatsAppGroupCreate browser={browser} view={view} />}
        </div>
        <div className="relative">
          <SearchIcon className="absolute top-1/2 left-2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            aria-label={`Search ${section}`}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={`Search ${section}`}
            className="pl-8"
          />
        </div>
      </header>
      <ScrollArea className="min-h-0 flex-1">
        {filtered.map((entry) => (
          <Item
            key={entry.key}
            asChild
            variant={entry.key === view.conversation?.chat.key ? "muted" : "default"}
            className="relative min-h-16 flex-nowrap rounded-none border-0 px-4 py-2 after:absolute after:right-0 after:bottom-0 after:left-[4.5rem] after:border-b after:border-border/60 hover:bg-muted/70 focus-visible:bg-muted/70 [content-visibility:auto] [contain-intrinsic-size:64px]"
          >
            <button
              type="button"
              className="w-full min-w-0 text-left"
              onClick={() => void browser.select(entry.key)}
            >
              <ItemMedia>
                <WhatsAppAvatar
                  name={entry.name}
                  initials={entry.initials}
                  token={entry.avatar}
                  size="lg"
                />
              </ItemMedia>
              <ItemContent className="min-w-0 gap-0">
                <ItemTitle className="w-full truncate text-base">{entry.name}</ItemTitle>
                <ItemDescription className="flex items-center gap-1 leading-snug">
                  {entry.previewFromMe && <PreviewReceipt status={entry.previewReceipt} />}
                  {entry.previewFromMe && <span className="shrink-0">You:</span>}
                  <span className="truncate">{entry.description}</span>
                </ItemDescription>
              </ItemContent>
              <ItemActions className="ml-auto shrink-0 self-start pt-0.5 text-xs text-muted-foreground">
                {entry.lastMessageAt ? <time>{listTime(entry.lastMessageAt)}</time> : null}
              </ItemActions>
            </button>
          </Item>
        ))}
      </ScrollArea>
    </section>
  );
}
