import type { InputRenderable, KeyEvent, ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import { createWhatsAppBindings } from "@whatsappd/react";
import { useEffect, useRef, useState } from "react";
import type { TerminalApplication, TerminalSnapshot } from "../lib/whatsapp-terminal.ts";
import { WhatsAppAccountState } from "./whatsapp-account-state.tsx";
import { WhatsAppChatList } from "./whatsapp-chat-list.tsx";
import { WhatsAppConversation } from "./whatsapp-conversation.tsx";

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
      <WhatsAppAccountState account={snapshot.account} phase={snapshot.phase} />
      <box flexDirection="row" flexGrow={1}>
        {showChats && (
          <WhatsAppChatList
            chats={snapshot.chats}
            selectedChatId={snapshot.selectedChatId}
            focused={focus === "chats"}
            compact={compact}
          />
        )}
        {showConversation && (
          <WhatsAppConversation
            snapshot={snapshot}
            selected={selected}
            transcript={transcript}
            composer={composer}
            focus={focus}
            submit={() => void submit()}
          />
        )}
      </box>
      <box height={1} paddingX={1} justifyContent="space-between">
        <text fg="#8696a0">Tab focus · i compose · q quit</text>
        <text fg="#8696a0">durable Client state</text>
      </box>
    </box>
  );
}
