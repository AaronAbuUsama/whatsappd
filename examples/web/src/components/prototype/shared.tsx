"use client";

import {
  Attachment,
  AttachmentInfo,
  AttachmentPreview,
  Attachments,
  type AttachmentData,
} from "@/components/ai-elements/attachments";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  Message,
  MessageAction,
  MessageActions,
  MessageContent,
  MessageToolbar,
} from "@/components/ai-elements/message";
import {
  PromptInput,
  PromptInputActionAddAttachments,
  PromptInputActionMenu,
  PromptInputActionMenuContent,
  PromptInputActionMenuTrigger,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "@/components/ai-elements/prompt-input";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import {
  type PrototypeChat,
  type PrototypeMessage,
  prototypeChats,
  prototypeMessages,
  prototypeQrValue,
} from "@/lib/prototype-data";
import {
  AlertTriangleIcon,
  CheckCheckIcon,
  CheckIcon,
  Clock3Icon,
  CopyIcon,
  HistoryIcon,
  ImagePlusIcon,
  LoaderCircleIcon,
  MessageCircleMoreIcon,
  SearchIcon,
  SmilePlusIcon,
  WifiIcon,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useState } from "react";

export function ConnectionBadge({ compact = false }: { compact?: boolean }) {
  return (
    <Badge className="gap-1.5" variant="secondary">
      <span className="size-1.5 rounded-full bg-emerald-500" />
      {compact ? "Online" : "WhatsApp online"}
    </Badge>
  );
}

export function PairingCard({ className }: { className?: string }) {
  return (
    <Card className={cn("mx-auto w-full max-w-xl", className)}>
      <CardHeader className="text-center">
        <Badge className="mx-auto" variant="outline">
          Step 2 of 3
        </Badge>
        <CardTitle className="text-2xl">Link your WhatsApp account</CardTitle>
        <CardDescription>
          Open WhatsApp → Linked devices → Link a device, then scan this code.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="mx-auto w-fit rounded-2xl border bg-white p-4 shadow-sm">
          <QRCodeSVG aria-label="Prototype pairing QR code" size={220} value={prototypeQrValue} />
        </div>
        <Progress aria-label="Pairing progress" value={66} />
        <Alert>
          <WifiIcon />
          <AlertTitle>Waiting for your phone</AlertTitle>
          <AlertDescription>
            This prototype uses a harmless demo code. A real challenge is short-lived, protected,
            and never written to logs.
          </AlertDescription>
        </Alert>
        <p className="text-center text-muted-foreground text-xs">
          Code refreshes in 37 seconds · Keep this tab open
        </p>
      </CardContent>
    </Card>
  );
}

export function ChatList({ dense = false }: { dense?: boolean }) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="space-y-3 border-b p-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="font-semibold">Conversations</p>
            <p className="text-muted-foreground text-xs">4 retained chats</p>
          </div>
          <Button aria-label="Start conversation" size="icon-sm" variant="ghost">
            <MessageCircleMoreIcon />
          </Button>
        </div>
        <div className="relative">
          <SearchIcon className="absolute top-2.5 left-3 size-4 text-muted-foreground" />
          <Input aria-label="Search conversations" className="pl-9" placeholder="Search" />
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className={cn("space-y-1 p-2", !dense && "p-3")}>
          {prototypeChats.map((chat, index) => (
            <ChatRow active={index === 0} chat={chat} dense={dense} key={chat.id} />
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}

function ChatRow({
  chat,
  active,
  dense,
}: {
  chat: PrototypeChat;
  active: boolean;
  dense: boolean;
}) {
  return (
    <button
      className={cn(
        "flex w-full items-center gap-3 rounded-xl p-3 text-left transition-colors hover:bg-muted",
        active && "bg-muted",
        dense && "rounded-lg py-2",
      )}
      type="button"
    >
      <div className="relative">
        <Avatar>
          <AvatarFallback>{chat.initials}</AvatarFallback>
        </Avatar>
        {chat.online && (
          <span className="absolute right-0 bottom-0 size-2.5 rounded-full border-2 border-background bg-emerald-500" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3">
          <span className="truncate font-medium text-sm">{chat.name}</span>
          <span className="shrink-0 text-muted-foreground text-[11px]">{chat.time}</span>
        </div>
        <div className="mt-0.5 flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-muted-foreground text-xs">
            {chat.preview}
          </span>
          {chat.unread && (
            <Badge className="size-5 justify-center rounded-full p-0">{chat.unread}</Badge>
          )}
        </div>
      </div>
    </button>
  );
}

export function ConversationPanel({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-muted/25">
      <header className="flex h-16 shrink-0 items-center gap-3 border-b bg-background px-4">
        <Avatar>
          <AvatarFallback>PS</AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold">Product studio</p>
          <p className="text-muted-foreground text-xs">4 participants · Maya is online</p>
        </div>
        <ConnectionBadge compact />
      </header>
      <div className="border-b bg-background px-4 py-2">
        <Button className="h-7 gap-2 text-xs" size="sm" variant="ghost">
          <HistoryIcon /> Load older saved messages
        </Button>
      </div>
      <Conversation className="min-h-0">
        <ConversationContent
          className={cn("mx-auto w-full max-w-3xl gap-5", compact && "gap-3 p-3")}
        >
          {prototypeMessages.map((message) => (
            <PrototypeMessageRow key={message.id} message={message} />
          ))}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
      <div className="shrink-0 border-t bg-background p-3">
        <PrototypeComposer />
      </div>
    </div>
  );
}

function PrototypeMessageRow({ message }: { message: PrototypeMessage }) {
  const [reacted, setReacted] = useState(false);
  const attachment: AttachmentData | undefined = message.attachment && {
    id: message.id,
    type: "file",
    filename: message.attachment.filename,
    mediaType: message.attachment.mediaType,
    url: message.attachment.url,
  };
  return (
    <Message from={message.fromMe ? "user" : "assistant"}>
      {!message.fromMe && (
        <span className="font-medium text-muted-foreground text-xs">{message.sender}</span>
      )}
      <MessageContent className={cn(!message.fromMe && "rounded-lg bg-card px-4 py-3 shadow-xs")}>
        {attachment && (
          <Attachments className="mb-2" variant="list">
            <Attachment data={attachment}>
              <AttachmentPreview />
              <AttachmentInfo showMediaType />
            </Attachment>
          </Attachments>
        )}
        {message.text && <p className="whitespace-pre-wrap leading-relaxed">{message.text}</p>}
      </MessageContent>
      <MessageToolbar className="mt-0 text-muted-foreground text-[11px]">
        <div className="flex flex-wrap items-center gap-1.5">
          {message.reactions?.map((reaction) => (
            <button
              className="rounded-full border bg-background px-2 py-0.5"
              key={reaction.emoji}
              type="button"
            >
              {reaction.emoji} {reaction.count}
            </button>
          ))}
          {reacted && (
            <button className="rounded-full border bg-background px-2 py-0.5" type="button">
              👍 1
            </button>
          )}
          <MessageActions className="opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
            <Popover>
              <PopoverTrigger asChild>
                <Button aria-label="React to message" size="icon-xs" variant="ghost">
                  <SmilePlusIcon />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto">
                <PopoverHeader>
                  <PopoverTitle>React</PopoverTitle>
                  <PopoverDescription>Choose a WhatsApp reaction.</PopoverDescription>
                </PopoverHeader>
                <div className="flex gap-1">
                  {["👍", "❤️", "😂", "😮", "😢", "🙏"].map((emoji) => (
                    <Button
                      key={emoji}
                      onClick={() => setReacted(true)}
                      size="icon-sm"
                      variant="ghost"
                    >
                      {emoji}
                    </Button>
                  ))}
                </div>
              </PopoverContent>
            </Popover>
            <MessageAction label="Copy message" tooltip="Copy">
              <CopyIcon />
            </MessageAction>
          </MessageActions>
        </div>
        <div className="flex items-center gap-1">
          {message.operation === "executing" && (
            <>
              <LoaderCircleIcon className="size-3 animate-spin" /> Sending
            </>
          )}
          {message.operation === "outcome_unknown" && (
            <>
              <AlertTriangleIcon className="size-3 text-amber-600" /> Delivery unknown
            </>
          )}
          {!message.operation && (
            <>
              {message.time} <ReceiptIcon receipt={message.receipt} />
            </>
          )}
        </div>
      </MessageToolbar>
    </Message>
  );
}

function ReceiptIcon({ receipt }: { receipt?: PrototypeMessage["receipt"] }) {
  if (receipt === "queued") return <Clock3Icon className="size-3" />;
  if (receipt === "read" || receipt === "played")
    return <CheckCheckIcon className="size-3 text-sky-500" />;
  if (receipt === "delivered") return <CheckCheckIcon className="size-3" />;
  if (receipt === "sent") return <CheckIcon className="size-3" />;
  return null;
}

function PrototypeComposer() {
  return (
    <PromptInput accept="image/*,video/*,audio/*,.pdf" multiple onSubmit={() => undefined}>
      <PromptInputBody>
        <PromptInputTextarea aria-label="Message" placeholder="Message Product studio" />
      </PromptInputBody>
      <PromptInputFooter>
        <PromptInputTools>
          <PromptInputActionMenu>
            <PromptInputActionMenuTrigger tooltip="Attach media">
              <ImagePlusIcon />
            </PromptInputActionMenuTrigger>
            <PromptInputActionMenuContent>
              <PromptInputActionAddAttachments label="Photo, video, audio or document" />
            </PromptInputActionMenuContent>
          </PromptInputActionMenu>
          <span className="hidden text-muted-foreground text-xs sm:inline">
            Enter to send · Shift+Enter for a line break
          </span>
        </PromptInputTools>
        <PromptInputSubmit aria-label="Send message" />
      </PromptInputFooter>
    </PromptInput>
  );
}

export function UnknownOutcomeAlert() {
  return (
    <Alert className="border-amber-300 bg-amber-50 text-amber-950 dark:bg-amber-950/20 dark:text-amber-100">
      <AlertTriangleIcon />
      <AlertTitle>One send has an unknown outcome</AlertTitle>
      <AlertDescription>
        It may have reached WhatsApp. Check the conversation before sending it again.
      </AlertDescription>
    </Alert>
  );
}
