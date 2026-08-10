import type { TerminalChat } from "../lib/whatsapp-terminal.ts";

export function WhatsAppChatList({
  chats,
  selectedChatId,
  focused,
  compact,
}: {
  readonly chats: readonly TerminalChat[];
  readonly selectedChatId?: string;
  readonly focused: boolean;
  readonly compact: boolean;
}) {
  return (
    <box
      flexDirection="column"
      width={compact ? "100%" : 34}
      borderStyle="single"
      borderColor={focused ? "#25d366" : "#273842"}
      title=" Chats · ↑/↓ select · Enter open "
    >
      <scrollbox flexGrow={1} focused={focused}>
        {chats.map((chat) => {
          const active = chat.id === selectedChatId;
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
  );
}
