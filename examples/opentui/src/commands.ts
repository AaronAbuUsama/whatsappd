import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { WhatsAppClient } from "whatsappd";
import type { TerminalMessageAction } from "./components/whatsappd-tui/lib/whatsapp-terminal.ts";

export const commandWords = (input: string): string[] => {
  const output: string[] = [];
  const expression = /"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|(\S+)/g;
  for (const match of input.matchAll(expression)) {
    const value = match[1] ?? match[2] ?? match[3] ?? "";
    output.push(value.replace(/\\([\\"'])/g, "$1"));
  }
  return output;
};

const localStream = async (path: string): Promise<{ stream: AsyncIterable<Uint8Array> }> => {
  const absolute = resolve(path);
  const details = await stat(absolute);
  if (!details.isFile()) throw new Error(`Not a file: ${path}`);
  return {
    stream: (async function* () {
      for await (const chunk of createReadStream(absolute)) {
        yield typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      }
    })(),
  };
};

const argument = (
  command: string,
  args: readonly string[],
  index: number,
  label: string,
): string => {
  const value = args[index];
  if (!value) throw new Error(`${command} requires ${label}`);
  return value;
};

const numericArgument = (
  command: string,
  args: readonly string[],
  index: number,
  label: string,
): number => {
  const value = Number(argument(command, args, index, label));
  if (!Number.isFinite(value)) throw new Error(`${command} ${label} must be a finite number`);
  return value;
};

export const runOutboundCommand = async (
  client: WhatsAppClient,
  chatId: string,
  command: string,
  args: readonly string[],
): Promise<boolean> => {
  switch (command) {
    case "/image":
      await client.messages.send.image(
        chatId,
        await localStream(argument(command, args, 0, "a file path")),
        {
          caption: args.slice(1).join(" ") || undefined,
        },
      );
      return true;
    case "/video":
      await client.messages.send.video(
        chatId,
        await localStream(argument(command, args, 0, "a file path")),
        {
          caption: args.slice(1).join(" ") || undefined,
        },
      );
      return true;
    case "/audio":
      await client.messages.send.audio(
        chatId,
        await localStream(argument(command, args, 0, "a file path")),
        {
          mimetype: args[1],
        },
      );
      return true;
    case "/voice": {
      const seconds = args[1] ? numericArgument(command, args, 1, "seconds") : undefined;
      if (seconds !== undefined && seconds < 0)
        throw new Error("/voice seconds must not be negative");
      await client.messages.send.audio(
        chatId,
        await localStream(argument(command, args, 0, "an Ogg Opus file path")),
        {
          ptt: true,
          mimetype: "audio/ogg; codecs=opus",
          ...(seconds !== undefined && { seconds }),
        },
      );
      return true;
    }
    case "/document": {
      const path = argument(command, args, 0, "a file path");
      const mimetype = argument(command, args, 1, "a MIME type");
      const fileName = argument(command, args, 2, "a file name");
      await client.messages.send.document(chatId, await localStream(path), {
        mimetype,
        fileName,
        caption: args.slice(3).join(" ") || undefined,
      });
      return true;
    }
    case "/sticker":
      await client.messages.send.sticker(
        chatId,
        await localStream(argument(command, args, 0, "a file path")),
      );
      return true;
    case "/location":
      await client.messages.send.location(chatId, {
        lat: numericArgument(command, args, 0, "latitude"),
        lng: numericArgument(command, args, 1, "longitude"),
        ...(args[2] && { name: args[2] }),
        ...(args[3] && { address: args.slice(3).join(" ") }),
      });
      return true;
    case "/contact":
      await client.messages.send.contacts(chatId, {
        displayName: argument(command, args, 0, "a display name"),
        vcards: [args.slice(1).join(" ") || argument(command, args, 1, "a vCard")],
      });
      return true;
    default:
      return false;
  }
};

export const runSelectedCommand = async (
  command: string,
  args: readonly string[],
  act: (action: TerminalMessageAction) => Promise<void>,
): Promise<boolean> => {
  switch (command) {
    case "/react":
      await act({ kind: "react", emoji: argument(command, args, 0, "an emoji") });
      return true;
    case "/unreact":
      await act({ kind: "unreact" });
      return true;
    case "/edit":
      await act({ kind: "edit", text: args.join(" ") || argument(command, args, 0, "text") });
      return true;
    case "/revoke":
      await act({ kind: "revoke" });
      return true;
    case "/read":
      await act({ kind: "read" });
      return true;
    case "/history": {
      const count = args[0] ? numericArgument(command, args, 0, "count") : undefined;
      if (count !== undefined && (!Number.isInteger(count) || count < 1 || count > 50))
        throw new Error("/history count must be an integer in 1..50");
      await act({ kind: "history", ...(count !== undefined && { count }) });
      return true;
    }
    case "/typing": {
      const value = argument(command, args, 0, "on or off");
      if (value !== "on" && value !== "off") throw new Error("/typing requires on or off");
      await act({ kind: "typing", on: value === "on" });
      return true;
    }
    case "/ack":
      await act({ kind: "acknowledge" });
      return true;
    default:
      return false;
  }
};
