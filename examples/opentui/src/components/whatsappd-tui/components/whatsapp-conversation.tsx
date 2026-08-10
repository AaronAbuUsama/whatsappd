import type { InputRenderable, ScrollBoxRenderable } from "@opentui/core";
import type { RefObject } from "react";
import type { TerminalChat, TerminalSnapshot } from "../lib/whatsapp-terminal.ts";
import { WhatsAppComposer } from "./whatsapp-composer.tsx";
import { WhatsAppMessage } from "./whatsapp-message.tsx";

export function WhatsAppConversation({
  snapshot,
  selected,
  transcript,
  composer,
  focus,
  submit,
}: {
  readonly snapshot: TerminalSnapshot;
  readonly selected?: TerminalChat;
  readonly transcript: RefObject<ScrollBoxRenderable | null>;
  readonly composer: RefObject<InputRenderable | null>;
  readonly focus: "chats" | "messages" | "composer";
  readonly submit: () => void;
}) {
  return (
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
          <WhatsAppMessage key={message.id} message={message} />
        ))}
      </scrollbox>
      {snapshot.error && <text fg="#ff6b6b">{snapshot.error}</text>}
      <WhatsAppComposer
        composer={composer}
        focused={focus === "composer"}
        canSend={selected?.canSend ?? false}
        onSubmit={submit}
      />
    </box>
  );
}
