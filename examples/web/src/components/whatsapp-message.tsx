"use client";

import { useEffect, useState } from "react";

import {
  CheckCheckIcon,
  CheckIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  Clock3Icon,
  ContactRoundIcon,
  FileIcon,
  LoaderCircleIcon,
  MapPinIcon,
  PencilIcon,
  ReplyIcon,
  SmileIcon,
  Trash2Icon,
} from "lucide-react";
import { toast } from "sonner";
import EmojiPicker, { EmojiStyle, Theme } from "emoji-picker-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentMedia,
  AttachmentTitle,
} from "@/components/ui/attachment";
import { Bubble, BubbleContent, BubbleReactions } from "@/components/ui/bubble";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Item, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/ui/item";
import { Marker, MarkerContent } from "@/components/ui/marker";
import { Message, MessageContent, MessageFooter, MessageHeader } from "@/components/ui/message";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { WhatsAppBrowser } from "@/lib/whatsapp-browser";
import type { ApplicationMessage, ApplicationMessageContent } from "@/lib/whatsapp-application";

function shortTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(
    timestamp,
  );
}

function Receipt({ receipt }: { readonly receipt: ApplicationMessage["receipt"] }) {
  if (!receipt) return null;
  if (receipt.participants.length)
    return (
      <span>
        {receipt.participants.map(({ status, count }) => `${count} ${status}`).join(" · ")}
      </span>
    );
  if (receipt.status === "pending") return <Clock3Icon aria-label="Pending" />;
  if (receipt.status === "error") return <CircleAlertIcon aria-label="Failed" />;
  if (receipt.status === "server_ack") return <CheckIcon aria-label="Sent" />;
  return receipt.status ? <CheckCheckIcon aria-label={receipt.status} /> : null;
}

function OperationState({
  message,
  browser,
}: {
  readonly message: ApplicationMessage;
  readonly browser: WhatsAppBrowser;
}) {
  const operation = message.operation;
  if (!operation) return null;
  if (operation.status === "failed")
    return (
      <Alert variant="destructive">
        <CircleAlertIcon />
        <AlertTitle>Could not send</AlertTitle>
        <AlertDescription>
          {operation.detail ?? "The send failed before WhatsApp accepted it."}
        </AlertDescription>
      </Alert>
    );
  if (operation.status === "outcome_unknown")
    return (
      <Alert>
        <CircleAlertIcon />
        <AlertTitle>Delivery could not be confirmed</AlertTitle>
        <AlertDescription>
          It may have sent. Check WhatsApp before trying again.
          <Button
            variant="link"
            size="sm"
            onClick={() => void browser.command({ type: "acknowledge", operation: operation.key })}
          >
            Dismiss
          </Button>
        </AlertDescription>
      </Alert>
    );
  return (
    <span className="inline-flex items-center gap-1">
      {operation.status === "succeeded" ? (
        <CheckIcon />
      ) : (
        <LoaderCircleIcon className="animate-spin" />
      )}
      {operation.status === "queued"
        ? "Queued"
        : operation.status === "claimed"
          ? "Preparing"
          : operation.status === "executing"
            ? "Sending"
            : "Sent, syncing"}
    </span>
  );
}

function MediaContent({
  content,
}: {
  readonly content: Extract<ApplicationMessageContent, { state: unknown }>;
}) {
  const [loadFailed, setLoadFailed] = useState(false);
  useEffect(() => setLoadFailed(false), [content.media]);
  const unavailable =
    content.state === "failed"
      ? {
          title: "Media download failed",
          description: content.failure ?? "WhatsApp media could not be saved.",
        }
      : !content.media
        ? {
            title: "Media reference missing",
            description: "This stored message has no media reference.",
          }
        : loadFailed
          ? {
              title: "Stored media missing",
              description: "The saved media file could not be reopened.",
            }
          : undefined;
  if (unavailable)
    return (
      <Attachment state="error">
        <AttachmentMedia>
          <CircleAlertIcon />
        </AttachmentMedia>
        <AttachmentContent>
          <AttachmentTitle>{unavailable.title}</AttachmentTitle>
          <AttachmentDescription>{unavailable.description}</AttachmentDescription>
        </AttachmentContent>
      </Attachment>
    );
  const url = `/api/media/${content.media}`;
  if (content.kind === "image" || content.kind === "sticker")
    return (
      <Attachment orientation="vertical">
        <AttachmentMedia variant="image">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={url}
            alt={content.text ?? content.fileName ?? content.kind}
            onError={() => setLoadFailed(true)}
          />
        </AttachmentMedia>
        {content.text && (
          <AttachmentContent>
            <AttachmentDescription>{content.text}</AttachmentDescription>
          </AttachmentContent>
        )}
      </Attachment>
    );
  if (content.kind === "video")
    return (
      <video
        controls
        preload="metadata"
        src={url}
        aria-label={content.text ?? "Video message"}
        onError={() => setLoadFailed(true)}
      />
    );
  if (content.kind === "audio")
    return (
      <audio
        controls
        preload="metadata"
        src={url}
        aria-label={content.ptt ? "Voice message" : "Audio message"}
        onError={() => setLoadFailed(true)}
      />
    );
  return (
    <Attachment>
      <AttachmentMedia>
        <FileIcon />
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle>{content.fileName ?? "Document"}</AttachmentTitle>
        <AttachmentDescription>{content.mimetype ?? "Saved media"}</AttachmentDescription>
      </AttachmentContent>
      <AttachmentActions>
        <AttachmentAction asChild>
          <a href={url} download={content.fileName}>
            Download
          </a>
        </AttachmentAction>
      </AttachmentActions>
    </Attachment>
  );
}

export function WhatsAppMessageContent({
  content,
}: {
  readonly content: ApplicationMessageContent;
}) {
  switch (content.kind) {
    case "text":
      return <p className="whitespace-pre-wrap">{content.text}</p>;
    case "image":
    case "video":
    case "audio":
    case "document":
    case "sticker":
      return <MediaContent content={content} />;
    case "location":
      return (
        <Item asChild>
          <a
            href={`https://www.openstreetmap.org/?mlat=${content.lat}&mlon=${content.lng}`}
            target="_blank"
            rel="noreferrer"
          >
            <ItemMedia>
              <MapPinIcon />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{content.name ?? "Location"}</ItemTitle>
              <ItemDescription>
                {content.address ?? `${content.lat}, ${content.lng}`}
              </ItemDescription>
            </ItemContent>
          </a>
        </Item>
      );
    case "contacts":
      return (
        <div>
          {content.contacts.map((contact, index) => (
            <Item key={`${contact.name ?? "contact"}-${index}`}>
              <ItemMedia>
                <ContactRoundIcon />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>{contact.name ?? "Contact card"}</ItemTitle>
              </ItemContent>
            </Item>
          ))}
        </div>
      );
    case "poll":
      return (
        <div>
          <strong>{content.name}</strong>
          {content.options.map((option) => (
            <Item key={option} size="xs">
              <ItemTitle>{option}</ItemTitle>
            </Item>
          ))}
        </div>
      );
    case "revoked":
      return (
        <Marker>
          <MarkerContent>This message was deleted</MarkerContent>
        </Marker>
      );
    case "unsupported":
      return (
        <Marker>
          <MarkerContent>Unsupported message ({content.rawType})</MarkerContent>
        </Marker>
      );
  }
}

function MessageActions({
  message,
  browser,
  onReply,
}: {
  readonly message: ApplicationMessage;
  readonly browser: WhatsAppBrowser;
  readonly onReply: () => void;
}) {
  const [reactionOpen, setReactionOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  if (message.operation) return null;
  const run = (command: Parameters<WhatsAppBrowser["command"]>[0]): void => {
    void browser
      .command(command)
      .catch((error) => toast.error(error instanceof Error ? error.message : "Command failed"));
  };
  return (
    <div
      className={`invisible absolute top-0 z-20 flex rounded-md bg-background/90 shadow-sm backdrop-blur group-hover/message:visible group-focus-within/message:visible ${message.fromMe ? "right-full mr-1" : "left-full ml-1"}`}
    >
      <Popover
        open={reactionOpen}
        onOpenChange={(open) => {
          setReactionOpen(open);
          if (!open) setExpanded(false);
        }}
      >
        <PopoverTrigger asChild>
          <Button variant="ghost" size="icon-xs" aria-label="React">
            <SmileIcon />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-1" side="top" align={message.fromMe ? "end" : "start"}>
          {expanded ? (
            <EmojiPicker
              width="min(320px, calc(100vw - 2rem))"
              height={360}
              theme={Theme.AUTO}
              emojiStyle={EmojiStyle.NATIVE}
              lazyLoadEmojis
              onEmojiClick={({ emoji }) => {
                run({ type: "react", message: message.key, emoji });
                setReactionOpen(false);
              }}
            />
          ) : (
            <div className="flex items-center gap-0.5">
              {["👍", "❤️", "😂", "😮", "😢", "🙏"].map((emoji) => (
                <Button
                  key={emoji}
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="text-base"
                  onClick={() => {
                    run({ type: "react", message: message.key, emoji });
                    setReactionOpen(false);
                  }}
                >
                  {emoji}
                </Button>
              ))}
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="More reactions"
                onClick={() => setExpanded(true)}
              >
                +
              </Button>
            </div>
          )}
        </PopoverContent>
      </Popover>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-xs" aria-label="Message actions">
            <ChevronDownIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align={message.fromMe ? "start" : "end"}>
          <DropdownMenuItem onSelect={onReply}>
            <ReplyIcon />
            Reply
          </DropdownMenuItem>
          {message.fromMe && message.content.kind === "text" && (
            <DropdownMenuItem
              onSelect={() => {
                const value = window.prompt(
                  "Edit message",
                  message.content.kind === "text" ? message.content.text : "",
                );
                if (value) run({ type: "edit", message: message.key, text: value });
              }}
            >
              <PencilIcon />
              Edit
            </DropdownMenuItem>
          )}
          {message.fromMe && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onSelect={() => run({ type: "revoke", message: message.key })}
              >
                <Trash2Icon />
                Delete for everyone
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

export function WhatsAppMessage({
  message,
  browser,
  onReply,
}: {
  readonly message: ApplicationMessage;
  readonly browser: WhatsAppBrowser;
  readonly onReply: () => void;
}) {
  return (
    <Message align={message.fromMe ? "end" : "start"}>
      <MessageContent>
        {message.sender && <MessageHeader>{message.sender}</MessageHeader>}
        <Bubble
          variant={message.fromMe ? "default" : "secondary"}
          align={message.fromMe ? "end" : "start"}
        >
          <BubbleContent>
            {message.quote && (
              <Item variant="muted" size="xs">
                <ItemContent>
                  {message.quote.sender && <ItemTitle>{message.quote.sender}</ItemTitle>}
                  <ItemDescription>{message.quote.text ?? "Quoted message"}</ItemDescription>
                </ItemContent>
              </Item>
            )}
            <WhatsAppMessageContent content={message.content} />
          </BubbleContent>
          <MessageActions message={message} browser={browser} onReply={onReply} />
          {message.reactions.length > 0 && (
            <BubbleReactions align={message.fromMe ? "end" : "start"}>
              {message.reactions.map(({ emoji, count }) => (
                <button
                  key={emoji}
                  type="button"
                  className="rounded-full px-1 py-0.5 text-xs hover:bg-accent"
                  onClick={() => void browser.command({ type: "unreact", message: message.key })}
                >
                  {emoji}
                  {count > 1 ? ` ${count}` : ""}
                </button>
              ))}
            </BubbleReactions>
          )}
        </Bubble>
        <MessageFooter>
          {message.viewOnce && <span>View once ·&nbsp;</span>}
          {message.ephemeral && <span>Disappearing ·&nbsp;</span>}
          {message.edited && <span>Edited ·&nbsp;</span>}
          <time>{shortTime(message.timestamp)}</time>
          {message.fromMe && <Receipt receipt={message.receipt} />}
          <OperationState message={message} browser={browser} />
        </MessageFooter>
      </MessageContent>
    </Message>
  );
}
