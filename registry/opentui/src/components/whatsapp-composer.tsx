import type { InputRenderable } from "@opentui/core";
import type { RefObject } from "react";

export function WhatsAppComposer({
  composer,
  focused,
  canSend,
  onSubmit,
}: {
  readonly composer: RefObject<InputRenderable | null>;
  readonly focused: boolean;
  readonly canSend: boolean;
  readonly onSubmit: () => void;
}) {
  return (
    <box height={3} borderStyle="single" borderColor={focused ? "#25d366" : "#273842"}>
      <input
        ref={composer}
        flexGrow={1}
        focused={focused}
        placeholder={
          canSend
            ? "i · compose · Enter send · Esc transcript"
            : "Read-only: destination is not allowlisted"
        }
        onSubmit={onSubmit}
      />
    </box>
  );
}
