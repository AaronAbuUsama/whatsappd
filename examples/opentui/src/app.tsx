import type { InputRenderable, KeyEvent, ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import { useEffect, useRef, useState } from "react";
import { createWhatsAppBindings } from "@whatsappd/react";
import type { TerminalApplication, TerminalSnapshot } from "./application.ts";

const { WhatsAppProvider, useWhatsAppSnapshot, useWhatsAppStore } = createWhatsAppBindings<
  TerminalSnapshot,
  TerminalApplication
>();

export function WhatsAppTui({ application }: { readonly application: TerminalApplication }) {
  return (
    <WhatsAppProvider store={application}>
      <WhatsAppTuiContent />
    </WhatsAppProvider>
  );
}

function WhatsAppTuiContent() {
  const application = useWhatsAppStore();
  const snapshot = useWhatsAppSnapshot();
  const renderer = useRenderer();
  const { width } = useTerminalDimensions();
  const compact = width < 80;
  const [focus, setFocus] = useState<"chats" | "messages" | "composer">("chats");
  const [anchor, setAnchor] = useState<string>();
  const [sending, setSending] = useState(false);
  const transcript = useRef<ScrollBoxRenderable>(null);
  const composer = useRef<InputRenderable>(null);

  useEffect(() => {
    if (!anchor || snapshot.older === "loading") return;
    transcript.current?.scrollChildIntoView(`message-${anchor}`);
    setAnchor(undefined);
  }, [anchor, snapshot.older, snapshot.messages.length]);

  const submit = async (input?: string): Promise<void> => {
    const value = (input ?? composer.current?.value ?? "").trim();
    if (!value || sending) return;
    setSending(true);
    try {
      await application.sendText(value);
      composer.current?.clear();
    } catch {
      // The application snapshot owns the visible failure.
    } finally {
      setSending(false);
    }
  };

  const handleChatKey = (key: KeyEvent): void => {
    if (key.name === "down" || key.name === "j") return application.selectOffset(1);
    if (key.name === "up" || key.name === "k") return application.selectOffset(-1);
    if (key.name !== "return") return;
    transcript.current?.focus();
    setFocus("messages");
  };

  const handleMessageKey = (key: KeyEvent): void => {
    if (key.name === "escape") return setFocus("chats");
    if (key.name === "o") setAnchor(application.loadOlder());
  };

  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") return renderer.destroy();
    if (focus === "composer") {
      if (key.name === "escape") {
        composer.current?.blur();
        transcript.current?.focus();
        setFocus("messages");
      }
      return;
    }
    if (key.name === "q") return renderer.destroy();
    if (key.name === "tab") {
      if (focus === "chats") {
        transcript.current?.focus();
        setFocus("messages");
      } else {
        composer.current?.focus();
        setFocus("composer");
      }
      return;
    }
    if (key.name === "i") {
      key.preventDefault();
      key.stopPropagation();
      composer.current?.focus();
      setFocus("composer");
      return;
    }
    if (focus === "chats") return handleChatKey(key);
    handleMessageKey(key);
  });

  const selected = snapshot.chats.find((chat) => chat.id === snapshot.selectedChatId);
  const showChats = !compact || focus === "chats";
  const showConversation = !compact || focus !== "chats";

  return (
    <box flexDirection="column" width="100%" height="100%" backgroundColor="#0b141a">
      <box height={3} paddingX={1} justifyContent="space-between" alignItems="center">
        <text fg="#e9edef">
          <strong>whatsappd</strong> · {snapshot.account}
        </text>
        <text fg={snapshot.phase === "online" ? "#25d366" : "#f0b429"}>{snapshot.phase}</text>
      </box>
      <box flexDirection="row" flexGrow={1}>
        {showChats && (
          <box
            flexDirection="column"
            width={compact ? "100%" : 34}
            borderStyle="single"
            borderColor={focus === "chats" ? "#25d366" : "#273842"}
            title=" Chats · ↑/↓ select · Enter open "
          >
            <scrollbox flexGrow={1} focused={focus === "chats"}>
              {snapshot.chats.map((chat) => {
                const active = chat.id === snapshot.selectedChatId;
                return (
                  <box
                    key={chat.id}
                    flexDirection="column"
                    height={3}
                    paddingX={1}
                    backgroundColor={active ? "#202c33" : "#111b21"}
                  >
                    <text fg={active ? "#ffffff" : "#e9edef"}>
                      {chat.isGroup ? "◉" : "○"} {chat.name}
                      {chat.canSend ? "" : " · read-only"}
                    </text>
                    <text fg="#8696a0">{chat.preview}</text>
                  </box>
                );
              })}
            </scrollbox>
          </box>
        )}
        {showConversation && (
          <box flexDirection="column" flexGrow={1}>
            <box height={3} paddingX={1} borderStyle="single" borderColor="#273842">
              <text fg="#e9edef">
                <strong>{snapshot.selectedChatName ?? "No chat selected"}</strong>
              </text>
              <text fg="#8696a0">{selected?.isGroup ? "Group" : "Contact"} · Esc chats</text>
            </box>
            <scrollbox
              ref={transcript}
              flexGrow={1}
              padding={1}
              focused={focus === "messages"}
              stickyScroll
              stickyStart="bottom"
              borderStyle="single"
              borderColor={focus === "messages" ? "#25d366" : "#273842"}
            >
              <box height={2} justifyContent="center">
                <text fg="#8696a0">
                  {snapshot.older === "stored" ? "o · load older saved messages" : snapshot.older}
                </text>
              </box>
              {snapshot.messages.map((message) => (
                <box
                  id={`message-${message.id}`}
                  key={message.id}
                  flexDirection="column"
                  alignSelf={message.fromMe ? "flex-end" : "flex-start"}
                  maxWidth="78%"
                  marginBottom={1}
                  paddingX={1}
                  backgroundColor={message.fromMe ? "#005c4b" : "#202c33"}
                >
                  <text fg="#aebac1">
                    {message.author} · {message.kind}
                  </text>
                  <text fg="#e9edef">{message.body}</text>
                  {(message.status || message.reactions.length > 0) && (
                    <text
                      fg={
                        message.status === "failed"
                          ? "#ff6b6b"
                          : message.status === "outcome_unknown"
                            ? "#f0b429"
                            : "#aebac1"
                      }
                    >
                      {[message.status, message.detail, ...message.reactions]
                        .filter(Boolean)
                        .join(" · ")}
                    </text>
                  )}
                </box>
              ))}
            </scrollbox>
            {snapshot.error && <text fg="#ff6b6b">{snapshot.error}</text>}
            <box
              height={3}
              borderStyle="single"
              borderColor={focus === "composer" ? "#25d366" : "#273842"}
            >
              <input
                ref={composer}
                flexGrow={1}
                focused={focus === "composer"}
                placeholder={
                  selected?.canSend
                    ? "i · compose · Enter send · Esc transcript"
                    : "Read-only: destination is not allowlisted"
                }
                onSubmit={() => void submit()}
              />
            </box>
          </box>
        )}
      </box>
      <box height={1} paddingX={1} justifyContent="space-between">
        <text fg="#8696a0">Tab focus · i compose · q quit</text>
        <text fg="#8696a0">durable Client state</text>
      </box>
    </box>
  );
}
