"use client";

import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import {
  CircleAlertIcon,
  ContactRoundIcon,
  FileIcon,
  ImageIcon,
  MapPinIcon,
  MicIcon,
  PaperclipIcon,
  ReplyIcon,
  SendIcon,
  SmileIcon,
  SquareIcon,
  VideoIcon,
  UsersIcon,
  XIcon,
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
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
} from "@/components/ui/attachment";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import type { WhatsAppBrowser } from "@/lib/whatsapp-browser";
import type {
  ApplicationChat,
  ApplicationMessage,
  ApplicationMessageContent,
} from "@/lib/whatsapp-application";

type PendingAttachment = {
  readonly file: File;
  readonly type: "send_image" | "send_video" | "send_audio" | "send_document" | "send_sticker";
  readonly gifPlayback?: boolean;
  readonly ptt?: boolean;
  readonly seconds?: number;
};

export function WhatsAppComposer({
  browser,
  chat,
  reply,
  clearReply,
  participants,
}: {
  readonly browser: WhatsAppBrowser;
  readonly chat: ApplicationChat;
  readonly reply?: ApplicationMessage;
  readonly clearReply: () => void;
  readonly participants: readonly { readonly key: string; readonly name: string }[];
}) {
  const [text, setText] = useState("");
  const [attachment, setAttachment] = useState<PendingAttachment>();
  const [recording, setRecording] = useState<"idle" | "requesting" | "recording">("idle");
  const [mentions, setMentions] = useState<string[]>([]);
  const [contactOpen, setContactOpen] = useState(false);
  const [contactName, setContactName] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const recorder = useRef<MediaRecorder | undefined>(undefined);
  const recordingStream = useRef<MediaStream | undefined>(undefined);
  const recordingCancelled = useRef(false);
  const recordingAttempt = useRef(0);
  const recordingStarted = useRef(0);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const input = useRef<HTMLInputElement>(null);
  const canSend = chat.canSend;

  useEffect(
    () => () => {
      if (typingTimer.current) clearTimeout(typingTimer.current);
      recordingAttempt.current += 1;
      recordingCancelled.current = true;
      if (recorder.current?.state === "recording") recorder.current.stop();
      recordingStream.current?.getTracks().forEach((track) => track.stop());
      if (canSend)
        void browser.command({ type: "typing", chat: chat.key, on: false }).catch(() => {});
    },
    [browser, canSend, chat.key],
  );

  const typing = (): void => {
    if (!canSend) return;
    void browser.command({ type: "typing", chat: chat.key, on: true }).catch(() => {});
    if (typingTimer.current) clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(
      () => void browser.command({ type: "typing", chat: chat.key, on: false }).catch(() => {}),
      2_000,
    );
  };
  const choose = (type: PendingAttachment["type"], accept: string, gifPlayback?: boolean): void => {
    const element = input.current;
    if (!element) return;
    element.accept = accept;
    element.dataset.type = type;
    element.dataset.gif = String(gifPlayback === true);
    element.click();
  };
  const selected = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    const type = event.target.dataset.type as PendingAttachment["type"] | undefined;
    if (file && type)
      setAttachment({
        file,
        type,
        ...(event.target.dataset.gif === "true" && { gifPlayback: true }),
      });
    event.target.value = "";
  };
  const submit = async (event?: FormEvent): Promise<void> => {
    event?.preventDefault();
    if (!canSend) return;
    const options = {
      ...(reply && { quote: reply.key }),
      ...(mentions.length && { mentions }),
    };
    try {
      if (attachment) {
        if (attachment.type === "send_image")
          await browser.sendMedia(
            { type: "send_image", chat: chat.key, ...options, ...(text && { caption: text }) },
            attachment.file,
          );
        else if (attachment.type === "send_video")
          await browser.sendMedia(
            {
              type: "send_video",
              chat: chat.key,
              ...options,
              ...(text && { caption: text }),
              ...(attachment.gifPlayback && { gifPlayback: true }),
            },
            attachment.file,
          );
        else if (attachment.type === "send_audio")
          await browser.sendMedia(
            {
              type: "send_audio",
              chat: chat.key,
              ...options,
              mimetype: attachment.file.type || "application/octet-stream",
              ...(attachment.ptt && { ptt: true }),
              ...(attachment.seconds !== undefined && { seconds: attachment.seconds }),
            },
            attachment.file,
          );
        else if (attachment.type === "send_document")
          await browser.sendMedia(
            {
              type: "send_document",
              chat: chat.key,
              ...options,
              fileName: attachment.file.name,
              mimetype: attachment.file.type || "application/octet-stream",
              ...(text && { caption: text }),
            },
            attachment.file,
          );
        else
          await browser.sendMedia(
            { type: "send_sticker", chat: chat.key, ...options },
            attachment.file,
          );
      } else if (text.trim())
        await browser.command({ type: "send_text", chat: chat.key, text, ...options });
      else return;
      setText("");
      setAttachment(undefined);
      setMentions([]);
      clearReply();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not send");
    }
  };
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  };
  const location = (): void =>
    navigator.geolocation.getCurrentPosition(
      ({ coords }) =>
        void browser
          .command({
            type: "send_location",
            chat: chat.key,
            location: { lat: coords.latitude, lng: coords.longitude },
            ...(reply && { quote: reply.key }),
          })
          .catch((error) => toast.error(error.message)),
      (error) => toast.error(error.message),
    );
  const toggleRecording = async (): Promise<void> => {
    if (recording === "recording") return recorder.current?.stop();
    if (recording === "requesting") return cancelRecording();
    const attempt = ++recordingAttempt.current;
    recordingCancelled.current = false;
    setRecording("requesting");
    let acquired: MediaStream | undefined;
    try {
      const stream = (acquired = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1 },
      }));
      if (attempt !== recordingAttempt.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const mediaRecorder = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      recordingStream.current = stream;
      mediaRecorder.ondataavailable = ({ data }) => chunks.push(data);
      mediaRecorder.onstop = () => {
        const current = attempt === recordingAttempt.current;
        if (current && !recordingCancelled.current) {
          const blob = new Blob(chunks, { type: mediaRecorder.mimeType });
          setAttachment({
            file: new File([blob], "recording.webm", { type: blob.type }),
            type: "send_audio",
            ptt: true,
            seconds: Math.max(1, Math.round((Date.now() - recordingStarted.current) / 1_000)),
          });
        }
        stream.getTracks().forEach((track) => track.stop());
        recordingStream.current = undefined;
        recorder.current = undefined;
        if (current) setRecording("idle");
      };
      mediaRecorder.onerror = () => {
        recordingCancelled.current = true;
        stream.getTracks().forEach((track) => track.stop());
        recordingStream.current = undefined;
        recorder.current = undefined;
        if (attempt === recordingAttempt.current) {
          setRecording("idle");
          toast.error("Recording failed");
        }
      };
      recorder.current = mediaRecorder;
      recordingStarted.current = Date.now();
      mediaRecorder.start();
      setRecording("recording");
    } catch (error) {
      acquired?.getTracks().forEach((track) => track.stop());
      recordingStream.current = undefined;
      recorder.current = undefined;
      if (attempt !== recordingAttempt.current) return;
      setRecording("idle");
      toast.error(error instanceof Error ? error.message : "Microphone unavailable");
    }
  };
  const cancelRecording = (): void => {
    recordingAttempt.current += 1;
    recordingCancelled.current = true;
    if (recorder.current?.state === "recording") recorder.current.stop();
    recordingStream.current?.getTracks().forEach((track) => track.stop());
    recordingStream.current = undefined;
    recorder.current = undefined;
    setRecording("idle");
  };

  const sendContact = async (): Promise<void> => {
    const name = contactName.trim();
    const digits = contactPhone.replace(/[^+\d]/g, "");
    if (!name || !/^\+?\d{7,15}$/.test(digits)) {
      toast.error("Enter a name and a valid international phone number");
      return;
    }
    const escaped = name.replaceAll("\\", "\\\\").replaceAll(";", "\\;").replaceAll(",", "\\,");
    try {
      await browser.command({
        type: "send_contacts",
        chat: chat.key,
        contacts: {
          displayName: name,
          vcards: [`BEGIN:VCARD\nVERSION:3.0\nFN:${escaped}\nTEL;TYPE=CELL:${digits}\nEND:VCARD`],
        },
        ...(reply && { quote: reply.key }),
      });
      setContactOpen(false);
      setContactName("");
      setContactPhone("");
      clearReply();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not send contact");
    }
  };

  return (
    <>
      <Dialog open={contactOpen} onOpenChange={setContactOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Send contact</DialogTitle>
            <DialogDescription>Create a WhatsApp contact card.</DialogDescription>
          </DialogHeader>
          <Input
            value={contactName}
            onChange={(event) => setContactName(event.target.value)}
            placeholder="Contact name"
            aria-label="Contact name"
          />
          <Input
            value={contactPhone}
            onChange={(event) => setContactPhone(event.target.value)}
            placeholder="International phone number"
            type="tel"
            aria-label="Contact phone number"
          />
          <DialogFooter>
            <Button onClick={() => void sendContact()}>Send contact</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <form onSubmit={(event) => void submit(event)} className="border-t p-3">
        {reply && (
          <Item variant="muted" size="sm">
            <ItemMedia>
              <ReplyIcon />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>Replying</ItemTitle>
              <ItemDescription>{preview(reply.content)}</ItemDescription>
            </ItemContent>
            <ItemActions>
              <Button type="button" variant="ghost" size="icon-xs" onClick={clearReply}>
                ×
              </Button>
            </ItemActions>
          </Item>
        )}
        {attachment && (
          <AttachmentGroup>
            <Attachment state="idle">
              <AttachmentMedia>
                {attachment.type === "send_image" ? (
                  <ImageIcon />
                ) : attachment.type === "send_video" ? (
                  <VideoIcon />
                ) : attachment.type === "send_audio" ? (
                  <MicIcon />
                ) : (
                  <FileIcon />
                )}
              </AttachmentMedia>
              <AttachmentContent>
                <AttachmentTitle>{attachment.file.name}</AttachmentTitle>
                <AttachmentDescription>{attachment.file.type || "File"}</AttachmentDescription>
              </AttachmentContent>
              <AttachmentActions>
                <AttachmentAction type="button" onClick={() => setAttachment(undefined)}>
                  ×
                </AttachmentAction>
              </AttachmentActions>
            </Attachment>
          </AttachmentGroup>
        )}
        {!canSend && (
          <Alert>
            <CircleAlertIcon />
            <AlertTitle>Sending unavailable</AlertTitle>
            <AlertDescription>
              {chat.sendDisabledReason ?? "This chat is read-only."}
            </AlertDescription>
          </Alert>
        )}
        <InputGroup>
          <InputGroupAddon>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <InputGroupButton type="button" disabled={!canSend} aria-label="Attach">
                  <PaperclipIcon />
                </InputGroupButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem onSelect={() => choose("send_image", "image/*")}>
                  <ImageIcon />
                  Image
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => choose("send_video", "video/*")}>
                  <VideoIcon />
                  Video
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => choose("send_video", "video/*", true)}>
                  <VideoIcon />
                  GIF-style video
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => choose("send_audio", "audio/*")}>
                  <MicIcon />
                  Audio
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => choose("send_document", "*/*")}>
                  <FileIcon />
                  Document
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => choose("send_sticker", "image/webp")}>
                  <SmileIcon />
                  Sticker
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={location}>
                  <MapPinIcon />
                  Current location
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setContactOpen(true)}>
                  <ContactRoundIcon />
                  Contact card
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <input ref={input} type="file" hidden onChange={selected} />
          </InputGroupAddon>
          <InputGroupTextarea
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              typing();
            }}
            onKeyDown={keyDown}
            disabled={!canSend}
            placeholder={attachment ? "Add a caption" : "Type a message"}
            rows={1}
            aria-label="Message"
          />
          <InputGroupAddon align="inline-end">
            {participants.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <InputGroupButton type="button" disabled={!canSend} aria-label="Mention">
                    <UsersIcon />
                  </InputGroupButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  {participants.map((participant) => (
                    <DropdownMenuItem
                      key={participant.key}
                      onSelect={() => {
                        setMentions((value) =>
                          value.includes(participant.key) ? value : [...value, participant.key],
                        );
                        setText(
                          (value) =>
                            `${value}${value && !value.endsWith(" ") ? " " : ""}@${participant.name} `,
                        );
                      }}
                    >
                      {participant.name}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            <Popover>
              <PopoverTrigger asChild>
                <InputGroupButton type="button" disabled={!canSend} aria-label="Emoji">
                  <SmileIcon />
                </InputGroupButton>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0">
                <EmojiPicker
                  width="min(320px, calc(100vw - 2rem))"
                  height={360}
                  theme={Theme.AUTO}
                  emojiStyle={EmojiStyle.NATIVE}
                  lazyLoadEmojis
                  onEmojiClick={({ emoji }) => setText((value) => value + emoji)}
                />
              </PopoverContent>
            </Popover>
            {recording !== "idle" ? (
              <>
                <InputGroupButton
                  type="button"
                  onClick={cancelRecording}
                  aria-label="Cancel recording"
                >
                  <XIcon />
                </InputGroupButton>
                {recording === "recording" && (
                  <InputGroupButton
                    type="button"
                    onClick={() => void toggleRecording()}
                    aria-label="Stop recording"
                  >
                    <SquareIcon className="text-destructive" />
                  </InputGroupButton>
                )}
              </>
            ) : !text && !attachment ? (
              <InputGroupButton
                type="button"
                disabled={!canSend}
                onClick={() => void toggleRecording()}
                aria-label="Record audio"
              >
                <MicIcon />
              </InputGroupButton>
            ) : (
              <InputGroupButton type="submit" disabled={!canSend} aria-label="Send">
                <SendIcon />
              </InputGroupButton>
            )}
          </InputGroupAddon>
        </InputGroup>
      </form>
    </>
  );
}

function preview(content: ApplicationMessageContent): string {
  if (content.kind === "text") return content.text;
  if ("text" in content && content.text) return content.text;
  if (content.kind === "poll") return content.name;
  return content.kind;
}
