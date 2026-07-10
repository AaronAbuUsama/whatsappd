/**
 * Eight plug-and-play agent tools over the {@link WhatsAppChannelAdapter}
 * surface. A framework adapter injects a {@link ToolContext} carrying the
 * current `chatId` and the channel adapter; each tool is a thin wrapper that
 * translates its input into an {@link Outbound} shape and calls
 * `adapter.send` / `adapter.markRead` / `adapter.setTyping`.
 *
 * These are the agent-facing surface that makes the outbound verbs callable
 * from an LLM.
 *
 * @packageDocumentation
 */
import type { WhatsAppChannelAdapter } from "../channel/types.ts";
import type { Outbound, BinaryInput, MessageRef } from "../model/outbound.ts";
import type { PresenceKind } from "../model/presence.ts";

/** Media kinds that `sendMedia` accepts. */
export type MediaKind = "image" | "video" | "audio" | "document" | "sticker";

/**
 * Per-call context injected by the framework adapter.
 *
 * @remarks
 * `chatId` is the conversation the agent is currently responding in, and
 * `adapter` is the channel adapter for the account handling that conversation.
 */
export interface ToolContext {
  readonly chatId: string;
  readonly adapter: WhatsAppChannelAdapter;
}

/**
 * A generic agent tool: a stable `name`, an LLM-facing `description`, and a
 * typed `call`.
 *
 * @typeParam I - The tool's input shape.
 * @typeParam O - The tool's result shape.
 */
export interface AgentTool<I = Record<string, unknown>, O = unknown> {
  /** Unique, namespaced tool name (e.g. `"whatsapp.sendText"`). */
  readonly name: string;
  /** Human-readable description surfaced to the model. */
  readonly description: string;
  /**
   * Execute the tool.
   *
   * @param input - The tool's typed input.
   * @param ctx - The per-call {@link ToolContext}.
   * @returns The tool's result.
   */
  call(input: I, ctx: ToolContext): Promise<O>;
}

// ── 1. sendText ──

export interface SendTextInput {
  text: string;
}

export const sendText: AgentTool<SendTextInput, MessageRef> = {
  name: "whatsapp.sendText",
  description: "Send a text message to the current WhatsApp conversation.",
  async call({ text }, ctx) {
    return ctx.adapter.send(ctx.chatId, { text });
  },
};

// ── 2. sendMedia ──

export interface SendMediaInput {
  kind: MediaKind;
  media: BinaryInput;
  caption?: string;
  /** audio: send as a push-to-talk voice note. */
  ptt?: boolean;
  /** audio: duration in seconds. */
  seconds?: number;
  /** audio/document: override mimetype. */
  mimetype?: string;
  /** document: filename (required for documents). */
  fileName?: string;
  /** video: play silently like a GIF. */
  gifPlayback?: boolean;
}

function mediaOutbound(input: SendMediaInput): Outbound {
  switch (input.kind) {
    case "image":
      return { image: input.media, caption: input.caption };
    case "video":
      return { video: input.media, caption: input.caption, gifPlayback: input.gifPlayback };
    case "audio":
      return {
        audio: input.media,
        ptt: input.ptt,
        seconds: input.seconds,
        mimetype: input.mimetype,
      };
    case "document":
      return {
        document: input.media,
        fileName: input.fileName ?? "file",
        mimetype: input.mimetype ?? "application/octet-stream",
        caption: input.caption,
      };
    case "sticker":
      return { sticker: input.media };
  }
}

export const sendMedia: AgentTool<SendMediaInput, MessageRef> = {
  name: "whatsapp.sendMedia",
  description:
    "Send an image, video, audio, document, or sticker to the current conversation. " +
    "Provide `media` as a Buffer, { url }, or { stream }. Documents require `fileName`.",
  async call(input, ctx) {
    return ctx.adapter.send(ctx.chatId, mediaOutbound(input));
  },
};

// ── 3. reply ──

export interface ReplyInput {
  text: string;
  quote: MessageRef;
}

export const reply: AgentTool<ReplyInput, MessageRef> = {
  name: "whatsapp.reply",
  description: "Reply to a specific message by quoting it.",
  async call({ text, quote }, ctx) {
    return ctx.adapter.send(ctx.chatId, { text }, { quote });
  },
};

// ── 4. markRead ──

export const markRead: AgentTool<void, void> = {
  name: "whatsapp.markRead",
  description: "Mark the current conversation as read (blue ticks).",
  async call(_input, ctx) {
    await ctx.adapter.markRead(ctx.chatId);
  },
};

// ── 5. setTyping ──

export interface SetTypingInput {
  kind?: PresenceKind;
}

export const setTyping: AgentTool<SetTypingInput, void> = {
  name: "whatsapp.setTyping",
  description:
    "Set typing or recording presence in the current conversation. " +
    "Defaults to 'typing'; pass 'recording' for voice-note mode.",
  async call({ kind = "typing" }, ctx) {
    await ctx.adapter.setTyping(ctx.chatId, kind);
  },
};

// ── 6. react ──

export interface ReactInput {
  emoji: string;
  ref: MessageRef;
}

export const react: AgentTool<ReactInput, MessageRef> = {
  name: "whatsapp.react",
  description: "React to a message with an emoji. Pass empty string to clear.",
  async call({ emoji, ref }, ctx) {
    return ctx.adapter.send(ctx.chatId, { react: { to: ref, emoji } });
  },
};

// ── 7. edit ──

export interface EditInput {
  text: string;
  ref: MessageRef;
}

export const edit: AgentTool<EditInput, MessageRef> = {
  name: "whatsapp.edit",
  description: "Edit a previously sent message.",
  async call({ text, ref }, ctx) {
    return ctx.adapter.send(ctx.chatId, { edit: { target: ref, text } });
  },
};

// ── 8. deleteMsg ──

export interface DeleteInput {
  ref: MessageRef;
}

export const deleteMsg: AgentTool<DeleteInput, MessageRef> = {
  name: "whatsapp.delete",
  description: "Delete a message (revoke for everyone).",
  async call({ ref }, ctx) {
    return ctx.adapter.send(ctx.chatId, { delete: ref });
  },
};

// ── Registry ──

/** All eight tools, in a fixed order. */
export const allTools: AgentTool<any, any>[] = [
  sendText,
  sendMedia,
  reply,
  markRead,
  setTyping,
  react,
  edit,
  deleteMsg,
];

/**
 * Get the full set of tools for a conversation.
 *
 * @remarks
 * Because each tool receives its {@link ToolContext} at call time, this
 * currently returns {@link allTools} unchanged. It exists as the stable entry
 * point a framework adapter calls once per conversation (or per session) to
 * obtain the tool array for its agent.
 *
 * @param _ctx - The conversation context (reserved for future per-context binding).
 * @returns The eight agent tools.
 */
export function bindTools(_ctx: ToolContext): AgentTool<any, any>[] {
  return allTools;
}
