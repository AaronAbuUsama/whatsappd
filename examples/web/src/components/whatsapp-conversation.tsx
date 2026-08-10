"use client";

import { useEffect, useRef, useState } from "react";
import {
  ArrowLeftIcon,
  CircleAlertIcon,
  MessageCircleIcon,
  MoreHorizontalIcon,
  PhoneIcon,
  VideoIcon,
} from "lucide-react";
import { WhatsAppAccountState } from "@/components/whatsapp-account-state";
import { WhatsAppAvatar } from "@/components/whatsapp-avatar";
import { WhatsAppComposer } from "@/components/whatsapp-composer";
import { WhatsAppGroupDetails } from "@/components/whatsapp-groups";
import { WhatsAppMessage } from "@/components/whatsapp-message";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { Item, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/ui/item";
import { Marker, MarkerContent } from "@/components/ui/marker";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import type {
  ApplicationMessage,
  WhatsAppApplicationView,
  WhatsAppBrowser,
} from "@/lib/whatsappd/web-contract";

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

const participantLabel = (count: number | undefined): string =>
  count === undefined ? "Participants not loaded" : `${count} participant${count === 1 ? "" : "s"}`;

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
        <Button variant="ghost" size="icon" className="size-11" aria-label="Conversation details">
          <MoreHorizontalIcon />
        </Button>
      </SheetTrigger>
      <SheetContent>
        <SheetHeader>
          <WhatsAppAvatar
            name={conversation.chat.name}
            initials={conversation.chat.initials}
            token={conversation.chat.avatar}
          />
          <SheetTitle>{conversation.chat.name}</SheetTitle>
          <SheetDescription>
            {conversation.chat.isGroup
              ? participantLabel(conversation.participants?.length)
              : (conversation.chat.presence ?? "Contact")}
          </SheetDescription>
        </SheetHeader>
        {conversation.chat.isGroup && conversation.chat.canSend ? (
          <ScrollArea className="min-h-0 flex-1 px-4">
            <WhatsAppGroupDetails browser={browser} view={view} />
          </ScrollArea>
        ) : conversation.chat.isGroup ? (
          <ScrollArea className="min-h-0 flex-1 px-2">
            {conversation.participants?.map((participant) => (
              <Item key={participant.key}>
                <ItemMedia>
                  <WhatsAppAvatar
                    name={participant.name}
                    initials={participant.name.slice(0, 2).toUpperCase()}
                  />
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

export function WhatsAppConversation({
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
          className="size-11 md:hidden"
          onClick={() => void browser.select()}
          aria-label="Back to chats"
        >
          <ArrowLeftIcon />
        </Button>
        <WhatsAppAvatar
          name={conversation.chat.name}
          initials={conversation.chat.initials}
          token={conversation.chat.avatar}
        />
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-semibold">{conversation.chat.name}</h2>
          <p className="truncate text-sm text-muted-foreground">
            {conversation.chat.presence ??
              (conversation.chat.isGroup
                ? participantLabel(conversation.participants?.length)
                : "WhatsApp contact")}
          </p>
        </div>
        <Button variant="ghost" size="icon" className="size-11" disabled aria-label="Video call">
          <VideoIcon />
        </Button>
        <Button variant="ghost" size="icon" className="size-11" disabled aria-label="Call">
          <PhoneIcon />
        </Button>
        <ConversationDetails browser={browser} view={view} />
      </header>
      <WhatsAppAccountState view={view} />
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
        participants={conversation.participants ?? []}
      />
    </section>
  );
}
