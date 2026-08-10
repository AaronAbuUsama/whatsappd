"use client";

import { ArrowLeftIcon, CircleAlertIcon, MessageCircleIcon, UserRoundIcon } from "lucide-react";
import { WhatsAppAvatar } from "@/components/whatsapp-avatar";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Item, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/ui/item";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { WhatsAppApplicationView, WhatsAppBrowser } from "@/lib/whatsappd/web-contract";

type Props = {
  readonly browser: WhatsAppBrowser;
  readonly view: WhatsAppApplicationView;
  readonly section: "contacts" | "groups";
  readonly selected?: string;
  readonly openChat: (key: string) => void;
  readonly openGroup: (key: string) => void;
};

const observedAt = (timestamp: number): string =>
  `Last observed ${new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(timestamp)}`;

function Header({
  browser,
  children,
}: {
  readonly browser: WhatsAppBrowser;
  readonly children: React.ReactNode;
}) {
  return (
    <header className="flex min-h-16 items-center gap-3 border-b px-4">
      <Button
        variant="ghost"
        size="icon"
        className="md:hidden"
        onClick={() => void browser.select()}
        aria-label="Back to directory"
      >
        <ArrowLeftIcon />
      </Button>
      {children}
    </header>
  );
}

export function WhatsAppDirectoryDetail({
  browser,
  view,
  section,
  selected,
  openChat,
  openGroup,
}: Props) {
  const contact = section === "contacts" ? view.contacts.find(({ key }) => key === selected) : null;
  const group = section === "groups" ? view.groups.find(({ key }) => key === selected) : null;
  if (!contact && !group)
    return (
      <Empty className="h-svh rounded-none border-0">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <UserRoundIcon />
          </EmptyMedia>
          <EmptyTitle>Select {section === "contacts" ? "a contact" : "a group"}</EmptyTitle>
          <EmptyDescription>
            Details appear here without treating the row as a chat.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );

  if (contact)
    return (
      <section className="flex h-svh min-w-0 flex-col">
        <Header browser={browser}>
          <WhatsAppAvatar
            name={contact.name}
            initials={contact.initials}
            token={contact.avatar}
            size="lg"
          />
          <div className="min-w-0 flex-1">
            <h2 className="truncate font-semibold">{contact.name}</h2>
            <p className="text-sm text-muted-foreground">WhatsApp contact</p>
          </div>
          <Button onClick={() => openChat(contact.key)}>
            <MessageCircleIcon />
            Message
          </Button>
        </Header>
        <ScrollArea className="min-h-0 flex-1">
          <div className="mx-auto flex max-w-2xl flex-col gap-6 p-6">
            <div>
              <h3 className="mb-2 text-sm font-medium">Names supplied by WhatsApp</h3>
              {contact.names.map((name) => (
                <Item key={name.label} variant="outline">
                  <ItemContent>
                    <ItemTitle>{name.value}</ItemTitle>
                    <ItemDescription>{name.label}</ItemDescription>
                  </ItemContent>
                </Item>
              ))}
            </div>
            {contact.about && (
              <div>
                <h3 className="mb-2 text-sm font-medium">About</h3>
                <p className="text-sm text-muted-foreground">{contact.about}</p>
              </div>
            )}
            {contact.lastSeenAt !== undefined && (
              <p className="text-sm text-muted-foreground">{observedAt(contact.lastSeenAt)}</p>
            )}
            {contact.commonGroups?.length ? (
              <div>
                <h3 className="mb-2 text-sm font-medium">Common groups</h3>
                {contact.commonGroups.map((common) => (
                  <Item key={common.key} asChild>
                    <button type="button" onClick={() => openGroup(common.key)}>
                      <ItemMedia>
                        <WhatsAppAvatar
                          name={common.name}
                          initials={common.name.slice(0, 2).toUpperCase()}
                        />
                      </ItemMedia>
                      <ItemContent>
                        <ItemTitle>{common.name}</ItemTitle>
                      </ItemContent>
                    </button>
                  </Item>
                ))}
              </div>
            ) : null}
          </div>
        </ScrollArea>
      </section>
    );

  const conversation = view.conversation?.chat.key === group!.key ? view.conversation : undefined;
  const participants = conversation?.participants;
  return (
    <section className="flex h-svh min-w-0 flex-col">
      <Header browser={browser}>
        <WhatsAppAvatar
          name={group!.name}
          initials={group!.initials}
          token={group!.avatar}
          size="lg"
        />
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-semibold">{group!.name}</h2>
          <p className="text-sm text-muted-foreground">
            {group!.participantCount === undefined
              ? "Participants not loaded"
              : `${group!.participantCount} participant${group!.participantCount === 1 ? "" : "s"}`}
          </p>
        </div>
        <Button onClick={() => openChat(group!.key)}>
          <MessageCircleIcon />
          Open chat
        </Button>
      </Header>
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto flex max-w-2xl flex-col gap-4 p-6">
          {conversation?.group?.description && (
            <p className="text-sm text-muted-foreground">{conversation.group.description}</p>
          )}
          {participants === undefined ? (
            <Alert>
              <CircleAlertIcon />
              <AlertTitle>Participants not loaded</AlertTitle>
              <AlertDescription>
                WhatsApp has not supplied an authoritative roster.
              </AlertDescription>
            </Alert>
          ) : participants.length === 0 ? (
            <p className="text-sm text-muted-foreground">No participants</p>
          ) : (
            participants.map((participant) => (
              <Item key={participant.key} variant="outline">
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
            ))
          )}
        </div>
      </ScrollArea>
    </section>
  );
}
