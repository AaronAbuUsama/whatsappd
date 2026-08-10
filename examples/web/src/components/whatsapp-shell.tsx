"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArchiveIcon,
  ArrowLeftIcon,
  CircleAlertIcon,
  ContactRoundIcon,
  LoaderCircleIcon,
  MessageCircleIcon,
  MoreHorizontalIcon,
  PhoneIcon,
  SearchIcon,
  SettingsIcon,
  UsersIcon,
  VideoIcon,
} from "lucide-react";
import { toast } from "sonner";
import { WhatsAppComposer } from "@/components/whatsapp-composer";
import { WhatsAppGroupCreate, WhatsAppGroupDetails } from "@/components/whatsapp-groups";
import { WhatsAppMessage } from "@/components/whatsapp-message";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Marker, MarkerContent } from "@/components/ui/marker";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from "@/components/ui/sidebar";
import { Spinner } from "@/components/ui/spinner";
import {
  createWhatsAppBrowser,
  useWhatsAppBrowser,
  type WhatsAppBrowser,
} from "@/lib/whatsapp-browser";
import type {
  ApplicationChat,
  ApplicationMessage,
  WhatsAppApplicationView,
} from "@/lib/whatsapp-application";

type Section = "chats" | "contacts" | "groups";

const shortTime = (timestamp: number): string =>
  timestamp
    ? new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(timestamp)
    : "";
const shortDate = (timestamp: number): string =>
  new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(timestamp);
const sameDay = (left: number, right: number): boolean => {
  const a = new Date(left);
  const b = new Date(right);
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
};

function AvatarView({
  name,
  initials,
  token,
}: {
  readonly name: string;
  readonly initials: string;
  readonly token?: string;
}) {
  return (
    <Avatar size="lg">
      {token && <AvatarImage src={`/api/avatar/${token}`} alt={name} />}
      <AvatarFallback>{initials}</AvatarFallback>
    </Avatar>
  );
}

function Navigation({
  section,
  setSection,
}: {
  readonly section: Section;
  readonly setSection: (section: Section) => void;
}) {
  const item = (value: Section, label: string, Icon: typeof MessageCircleIcon) => (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={section === value}
        tooltip={label}
        onClick={() => setSection(value)}
      >
        <Icon />
        <span>{label}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>{item("chats", "Chats", MessageCircleIcon)}</SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {item("contacts", "Contacts", ContactRoundIcon)}
              {item("groups", "Groups", UsersIcon)}
              <SidebarMenuItem>
                <SidebarMenuButton disabled tooltip="Archive is not exposed by the SDK">
                  <ArchiveIcon />
                  <span>Archived</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton disabled tooltip="Calls are not exposed by the SDK">
                  <PhoneIcon />
                  <span>Calls</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton disabled tooltip="Settings">
              <SettingsIcon />
              <span>Settings</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}

type ListEntry = Pick<ApplicationChat, "key" | "name" | "initials" | "avatar" | "canSend"> & {
  readonly description?: string;
  readonly lastMessageAt?: number;
};

function DirectoryList({
  browser,
  view,
  section,
}: {
  readonly browser: WhatsAppBrowser;
  readonly view: WhatsAppApplicationView;
  readonly section: Section;
}) {
  const [query, setQuery] = useState("");
  const entries = useMemo<readonly ListEntry[]>(() => {
    if (section === "contacts")
      return view.contacts.map((contact) => ({
        ...contact,
        description: contact.presence ?? contact.about,
      }));
    if (section === "groups")
      return view.groups.map((group) => ({
        ...group,
        description: `${group.participantCount} participants`,
      }));
    return view.chats.map((chat) => ({
      ...chat,
      description: chat.preview ?? (chat.isGroup ? "Group" : "Conversation"),
    }));
  }, [section, view]);
  const normalized = query.trim().toLocaleLowerCase();
  const filtered = normalized
    ? entries.filter((entry) => entry.name.toLocaleLowerCase().includes(normalized))
    : entries;
  return (
    <section className="flex h-svh min-w-0 flex-col">
      <header className="border-b p-3">
        <div className="mb-3 flex items-center justify-between">
          <h1 className="text-lg font-semibold">{section[0]!.toUpperCase() + section.slice(1)}</h1>
          {section === "groups" && <WhatsAppGroupCreate browser={browser} view={view} />}
        </div>
        <div className="relative">
          <SearchIcon className="absolute top-1/2 left-2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
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
          >
            <button type="button" className="w-full" onClick={() => void browser.select(entry.key)}>
              <ItemMedia>
                <AvatarView name={entry.name} initials={entry.initials} token={entry.avatar} />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>{entry.name}</ItemTitle>
                <ItemDescription>{entry.description}</ItemDescription>
              </ItemContent>
              <ItemActions>
                {entry.lastMessageAt ? <time>{shortTime(entry.lastMessageAt)}</time> : null}
                {!entry.canSend && <Badge variant="outline">Read only</Badge>}
              </ItemActions>
            </button>
          </Item>
        ))}
      </ScrollArea>
    </section>
  );
}

function ConnectionAlert({ view }: { readonly view: WhatsAppApplicationView }) {
  const connection = view.account.connection;
  if (!connection || connection.phase === "online") return null;
  if (connection.phase === "stale")
    return (
      <Alert className="rounded-none border-x-0 border-t-0">
        <CircleAlertIcon />
        <AlertTitle>Connection status is stale</AlertTitle>
        <AlertDescription>
          No recent live status was observed. Durable sends remain available.
        </AlertDescription>
      </Alert>
    );
  const terminal =
    connection.phase === "closed" ||
    connection.phase === "logged_out" ||
    connection.phase === "suspended";
  return (
    <Alert
      variant={terminal ? "destructive" : "default"}
      className="rounded-none border-x-0 border-t-0"
    >
      {terminal ? <CircleAlertIcon /> : <LoaderCircleIcon className="animate-spin" />}
      <AlertTitle>{connection.phase.replaceAll("_", " ")}</AlertTitle>
      <AlertDescription>{connection.detail ?? "WhatsApp is not ready yet."}</AlertDescription>
    </Alert>
  );
}

function ConversationDetails({
  browser,
  view,
}: {
  readonly browser: WhatsAppBrowser;
  readonly view: WhatsAppApplicationView;
}) {
  const conversation = view.conversation!;
  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Conversation details">
          <MoreHorizontalIcon />
        </Button>
      </SheetTrigger>
      <SheetContent>
        <SheetHeader>
          <AvatarView
            name={conversation.chat.name}
            initials={conversation.chat.initials}
            token={conversation.chat.avatar}
          />
          <SheetTitle>{conversation.chat.name}</SheetTitle>
          <SheetDescription>
            {conversation.chat.isGroup
              ? `${conversation.participants.length} participants`
              : (conversation.chat.presence ?? "Contact")}
          </SheetDescription>
        </SheetHeader>
        {conversation.chat.isGroup && conversation.chat.canSend ? (
          <ScrollArea className="min-h-0 flex-1 px-4">
            <WhatsAppGroupDetails browser={browser} view={view} />
          </ScrollArea>
        ) : conversation.chat.isGroup ? (
          <ScrollArea className="min-h-0 flex-1 px-2">
            {conversation.participants.map((participant, index) => (
              <Item key={`${participant.name}-${index}`}>
                <ItemMedia>
                  <Avatar>
                    <AvatarFallback>{participant.name.slice(0, 2).toUpperCase()}</AvatarFallback>
                  </Avatar>
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>{participant.name}</ItemTitle>
                  <ItemDescription>{participant.role ?? "Participant"}</ItemDescription>
                </ItemContent>
              </Item>
            ))}
          </ScrollArea>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function Conversation({
  browser,
  view,
}: {
  readonly browser: WhatsAppBrowser;
  readonly view: WhatsAppApplicationView;
}) {
  const conversation = view.conversation;
  const [reply, setReply] = useState<ApplicationMessage>();
  const marked = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!conversation?.chat.canSend) return;
    const incoming = conversation.messages
      .filter((message) => !message.fromMe && !message.operation)
      .map((message) => message.key);
    const marker = incoming.join(",");
    if (!incoming.length || marker === marked.current) return;
    marked.current = marker;
    void browser.command({ type: "mark_read", messages: incoming }).catch(() => {});
  }, [browser, conversation]);
  useEffect(() => setReply(undefined), [conversation?.chat.key]);
  if (!conversation)
    return (
      <Empty className="h-svh rounded-none border-0">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <MessageCircleIcon />
          </EmptyMedia>
          <EmptyTitle>whatsappd</EmptyTitle>
          <EmptyDescription>Select a conversation.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  return (
    <section className="flex h-svh min-w-0 flex-col">
      <header className="flex items-center gap-3 border-b p-3">
        <Button
          variant="ghost"
          size="icon"
          className="lg:hidden"
          onClick={() => void browser.select()}
          aria-label="Back to chats"
        >
          <ArrowLeftIcon />
        </Button>
        <AvatarView
          name={conversation.chat.name}
          initials={conversation.chat.initials}
          token={conversation.chat.avatar}
        />
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-semibold">{conversation.chat.name}</h2>
          <p className="truncate text-sm text-muted-foreground">
            {conversation.chat.presence ??
              (conversation.chat.isGroup
                ? `${conversation.participants.length} participants`
                : "WhatsApp contact")}
          </p>
        </div>
        <Button variant="ghost" size="icon" disabled aria-label="Video call">
          <VideoIcon />
        </Button>
        <Button variant="ghost" size="icon" disabled aria-label="Call">
          <PhoneIcon />
        </Button>
        <ConversationDetails browser={browser} view={view} />
      </header>
      <ConnectionAlert view={view} />
      <MessageScrollerProvider defaultScrollPosition="end">
        <MessageScroller>
          <MessageScrollerViewport>
            <MessageScrollerContent className="p-4">
              <MessageScrollerItem>
                <Paging browser={browser} conversation={conversation} />
              </MessageScrollerItem>
              {conversation.messages.map((message, index) => (
                <MessageScrollerItem key={message.key}>
                  {(index === 0 ||
                    !sameDay(conversation.messages[index - 1]!.timestamp, message.timestamp)) && (
                    <Marker variant="separator">
                      <MarkerContent>{shortDate(message.timestamp)}</MarkerContent>
                    </Marker>
                  )}
                  <WhatsAppMessage
                    message={message}
                    browser={browser}
                    onReply={() => setReply(message)}
                  />
                </MessageScrollerItem>
              ))}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton />
        </MessageScroller>
      </MessageScrollerProvider>
      <WhatsAppComposer
        browser={browser}
        chat={conversation.chat}
        reply={reply}
        clearReply={() => setReply(undefined)}
        participants={conversation.participants}
      />
    </section>
  );
}

function Paging({
  browser,
  conversation,
}: {
  readonly browser: WhatsAppBrowser;
  readonly conversation: NonNullable<WhatsAppApplicationView["conversation"]>;
}) {
  if (conversation.paging === "loading")
    return (
      <Marker>
        <MarkerContent>
          <Spinner />
          Loading older saved messages
        </MarkerContent>
      </Marker>
    );
  if (conversation.paging === "error")
    return (
      <Alert variant="destructive">
        <CircleAlertIcon />
        <AlertTitle>Could not load saved messages</AlertTitle>
        <AlertDescription>
          <Button
            variant="link"
            onClick={() =>
              void browser.command({ type: "load_older", chat: conversation.chat.key })
            }
          >
            Try again
          </Button>
        </AlertDescription>
      </Alert>
    );
  if (conversation.paging === "stored")
    return (
      <Button
        variant="outline"
        size="sm"
        onClick={() => void browser.command({ type: "load_older", chat: conversation.chat.key })}
      >
        Load older saved messages
      </Button>
    );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm">
          Start of saved messages
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem
          disabled={!conversation.chat.canSend || !conversation.messages.length}
          onSelect={() =>
            void browser.command({ type: "request_phone_history", chat: conversation.chat.key })
          }
        >
          Ask phone for older messages
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function WhatsAppShell({ initial }: { readonly initial: WhatsAppApplicationView }) {
  const [browser] = useState(() => createWhatsAppBrowser(initial));
  const { view, selected, pending, error } = useWhatsAppBrowser(browser);
  const [section, setSection] = useState<Section>("chats");
  useEffect(() => {
    if (error) toast.error(error);
  }, [error]);
  return (
    <SidebarProvider defaultOpen={false}>
      <Navigation section={section} setSection={setSection} />
      <SidebarInset>
        {pending > 0 && (
          <div className="fixed top-2 right-2 z-50">
            <Badge>
              <Spinner />
              Working
            </Badge>
          </div>
        )}
        <ResizablePanelGroup orientation="horizontal">
          <ResizablePanel
            defaultSize="360px"
            minSize="280px"
            maxSize="520px"
            className={selected ? "hidden lg:block" : undefined}
          >
            <DirectoryList browser={browser} view={view} section={section} />
          </ResizablePanel>
          <ResizableHandle className={selected ? "hidden lg:flex" : "hidden"} />
          <ResizablePanel minSize="420px" className={!selected ? "hidden lg:block" : undefined}>
            <Conversation browser={browser} view={view} />
          </ResizablePanel>
        </ResizablePanelGroup>
      </SidebarInset>
    </SidebarProvider>
  );
}
