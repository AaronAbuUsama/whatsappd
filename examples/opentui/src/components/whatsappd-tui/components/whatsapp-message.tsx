import type { TerminalMessage } from "../lib/whatsapp-terminal.ts";
import { WhatsAppOperationStatus } from "./whatsapp-operation-status.tsx";

export function WhatsAppMessage({ message }: { readonly message: TerminalMessage }) {
  return (
    <box
      id={`message-${message.id}`}
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
      <WhatsAppOperationStatus message={message} />
    </box>
  );
}
