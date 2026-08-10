import type { TerminalMessage } from "../lib/whatsapp-terminal.ts";

export function WhatsAppOperationStatus({ message }: { readonly message: TerminalMessage }) {
  if (!message.status && message.reactions.length === 0) return null;
  return (
    <text
      fg={
        message.status === "failed"
          ? "#ff6b6b"
          : message.status === "outcome_unknown"
            ? "#f0b429"
            : "#aebac1"
      }
    >
      {[message.status, message.detail, ...message.reactions].filter(Boolean).join(" · ")}
    </text>
  );
}
