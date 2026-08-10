import type { InputRenderable, TextareaRenderable } from "@opentui/core";
import { createWhatsAppBindings } from "@whatsappd/react";
import {
  MessageComposer,
  PaneFrame,
  PaneSidebar,
  PaneSidebarRow,
  addressFields,
  defineAction,
  defineModule,
  definePanel,
  defineTuiApp,
  getPaneSidebarWidth,
  humanPointerContext,
  humanUiContext,
  openPanel,
  useActionShortcut,
  useKeyHints,
  useShortcut,
  useTheme,
} from "agentic-tui-kit";
import type { ActionHandle, ActionRegistry } from "agentic-tui-kit";
import { useRef, useState } from "react";
import { z } from "zod";
import type {
  TerminalApplication,
  TerminalDirectoryEntry,
  TerminalMessageAction,
  TerminalSnapshot,
} from "./components/whatsappd-tui/lib/whatsapp-terminal.ts";

const { WhatsAppProvider, useWhatsAppSnapshot } = createWhatsAppBindings<
  TerminalSnapshot,
  TerminalApplication
>();

const accepted = z.object({ accepted: z.literal(true) });
const messageActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("react"), emoji: z.string().min(1) }),
  z.object({ kind: z.literal("unreact") }),
  z.object({ kind: z.literal("edit"), text: z.string().min(1) }),
  z.object({ kind: z.literal("revoke") }),
  z.object({ kind: z.literal("read") }),
  z.object({ kind: z.literal("history"), count: z.number().int().positive().optional() }),
  z.object({ kind: z.literal("typing"), on: z.boolean() }),
  z.object({ kind: z.literal("acknowledge") }),
]);
const groupActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("metadata"), groupId: z.string().min(1) }),
  z.object({
    kind: z.literal("create"),
    subject: z.string().min(1),
    participants: z.array(z.string().min(1)),
  }),
  z.object({ kind: z.literal("leave"), groupId: z.string().min(1) }),
  z.object({ kind: z.literal("subject"), groupId: z.string().min(1), subject: z.string().min(1) }),
  z.object({
    kind: z.literal("description"),
    groupId: z.string().min(1),
    description: z.string().optional(),
  }),
  z.object({
    kind: z.literal("participants"),
    groupId: z.string().min(1),
    participants: z.array(z.string().min(1)).min(1),
    action: z.enum(["add", "remove", "promote", "demote", "modify"]),
  }),
  z.object({
    kind: z.literal("setting"),
    groupId: z.string().min(1),
    setting: z.enum(["announcement", "not_announcement", "locked", "unlocked"]),
  }),
  z.object({ kind: z.literal("invite"), groupId: z.string().min(1) }),
  z.object({ kind: z.literal("revoke-invite"), groupId: z.string().min(1) }),
  z.object({ kind: z.literal("picture"), groupId: z.string().min(1), path: z.string().min(1) }),
  z.object({ kind: z.literal("remove-picture"), groupId: z.string().min(1) }),
]);

export function createWhatsAppTuiHarness(application: TerminalApplication, dispose?: () => void) {
  const setSection = defineAction({
    id: "whatsapp.section.set",
    title: "Open WhatsApp section",
    group: "WhatsApp",
    description: "Switch between chats, contacts, and groups.",
    inputSchema: z.object({ section: z.enum(["chats", "contacts", "groups"]) }),
    outputSchema: accepted,
    sideEffect: "none",
    paletteEntries: [
      { title: "Open chats", input: { section: "chats" as const } },
      { title: "Open contacts", input: { section: "contacts" as const } },
      { title: "Open groups", input: { section: "groups" as const } },
    ],
    execute: ({ section }) => (application.setSection(section), { accepted: true as const }),
  });
  const search = defineAction({
    id: "whatsapp.search",
    title: "Search current section",
    group: "WhatsApp",
    description: "Filter the current chats, contacts, or groups view.",
    inputSchema: z.object({ query: z.string() }),
    outputSchema: accepted,
    sideEffect: "none",
    execute: ({ query }) => (application.setQuery(query), { accepted: true as const }),
  });
  const selectChat = defineAction({
    id: "whatsapp.chat.select",
    title: "Select chat",
    group: "WhatsApp",
    description: "Open one projected WhatsApp chat.",
    inputSchema: z.object({ chatId: z.string().min(1) }),
    outputSchema: accepted,
    sideEffect: "none",
    execute: ({ chatId }) => (application.selectChat(chatId), { accepted: true as const }),
  });
  const moveChat = defineAction({
    id: "whatsapp.chat.move",
    title: "Move chat selection",
    group: "WhatsApp",
    description: "Move through the filtered chat list.",
    inputSchema: z.object({ offset: z.union([z.literal(-1), z.literal(1)]) }),
    outputSchema: accepted,
    sideEffect: "none",
    keybindings: [
      { chord: { name: "down" }, input: { offset: 1 as const }, hint: "next chat" },
      { chord: { name: "up" }, input: { offset: -1 as const }, hint: "previous chat" },
    ],
    execute: ({ offset }) => (application.selectOffset(offset), { accepted: true as const }),
  });
  const moveMessage = defineAction({
    id: "whatsapp.message.move",
    title: "Move message selection",
    group: "WhatsApp",
    description: "Move through the current transcript.",
    inputSchema: z.object({ offset: z.union([z.literal(-1), z.literal(1)]) }),
    outputSchema: accepted,
    sideEffect: "none",
    execute: ({ offset }) => (application.selectMessageOffset(offset), { accepted: true as const }),
  });
  const older = defineAction({
    id: "whatsapp.messages.older",
    title: "Load older saved messages",
    group: "WhatsApp",
    description: "Page older rows already present in the local mirror.",
    inputSchema: z.object({}),
    outputSchema: accepted,
    sideEffect: "local-read",
    keybindings: [{ chord: { name: "o" }, input: {}, hint: "older saved" }],
    execute: () => (application.loadOlder(), { accepted: true as const }),
  });
  const submit = defineAction({
    id: "whatsapp.message.submit",
    title: "Send message or command",
    group: "WhatsApp",
    description: "Send text or a validated slash command through the durable Client seam.",
    inputSchema: z.object({ input: z.string().min(1) }),
    outputSchema: accepted,
    sideEffect: "external-write",
    available: () =>
      application
        .getSnapshot()
        .chats.find((chat) => chat.id === application.getSnapshot().selectedChatId)?.canSend ||
      "Selected chat is read-only or the account cannot accept durable work.",
    execute: async ({ input }) => (await application.submit(input), { accepted: true as const }),
  });
  const messageAction = defineAction({
    id: "whatsapp.message.action",
    title: "Act on selected message",
    group: "WhatsApp",
    description:
      "React, edit, revoke, read, request history, type, or acknowledge through the Client.",
    inputSchema: messageActionSchema,
    outputSchema: accepted,
    sideEffect: "external-write",
    paletteEntries: [
      { title: "React 👍", input: { kind: "react" as const, emoji: "👍" } },
      { title: "Remove my reaction", input: { kind: "unreact" as const } },
      { title: "Mark selected message read", input: { kind: "read" as const } },
      {
        title: "Request 50 older messages from phone",
        input: { kind: "history" as const, count: 50 },
      },
      { title: "Acknowledge selected operation", input: { kind: "acknowledge" as const } },
    ],
    execute: async (input) => (
      await application.messageAction(input as TerminalMessageAction),
      { accepted: true as const }
    ),
  });
  const groupAction = defineAction({
    id: "whatsapp.group.action",
    title: "Run group command",
    group: "WhatsApp",
    description: "Run one current public Client group command through the final allowlist seam.",
    inputSchema: groupActionSchema,
    outputSchema: z.object({ accepted: z.literal(true), value: z.string().optional() }),
    sideEffect: "external-write",
    paletteEntries: () =>
      application.getSnapshot().groups.map((group) => ({
        title: `Inspect group metadata · ${group.name}`,
        detail: "Other group mutations remain typed agent actions to avoid one-click writes.",
        input: { kind: "metadata" as const, groupId: group.id },
      })),
    execute: async (input) => {
      const value = await application.groupAction(input);
      return { accepted: true as const, ...(value !== undefined && { value }) };
    },
  });
  const handles = {
    setSection,
    search,
    selectChat,
    moveChat,
    moveMessage,
    older,
    submit,
    messageAction,
    groupAction,
  };
  const panel = definePanel({
    type: "whatsapp",
    schema: z.object({ account: z.string() }),
    address: addressFields("account"),
    title: () => "WhatsApp",
    render: ({ panel, actions }) => (
      <WhatsAppProvider store={application}>
        <WhatsAppPanel panel={panel} actions={actions} handles={handles} />
      </WhatsAppProvider>
    ),
  });
  const definition = defineTuiApp({
    id: "whatsappd-opentui",
    brand: "WHATSAPPD",
    themeId: "green",
    modules: [
      defineModule({
        id: "whatsapp",
        panels: [panel],
        actions: Object.values(handles),
        dispose: () => {
          application.close();
          dispose?.();
        },
      }),
    ],
    initialWorkspaces: [
      {
        id: "inbox",
        name: "Inbox",
        open: [openPanel(panel, { account: application.getSnapshot().account })],
      },
    ],
  });
  return { definition, actions: handles };
}

export const createWhatsAppTui = (application: TerminalApplication, dispose?: () => void) =>
  createWhatsAppTuiHarness(application, dispose).definition;

type AnyAction = ActionHandle<any, any>;
type Handles = Record<
  | "setSection"
  | "search"
  | "selectChat"
  | "moveChat"
  | "moveMessage"
  | "older"
  | "submit"
  | "messageAction"
  | "groupAction",
  AnyAction
>;

function WhatsAppPanel({
  panel,
  actions,
  handles,
}: {
  readonly panel: {
    readonly rect: { readonly width: number; readonly height: number };
    readonly focused: boolean;
  };
  readonly actions: ActionRegistry;
  readonly handles: Handles;
}) {
  const snapshot = useWhatsAppSnapshot();
  const { theme } = useTheme();
  const [focus, setFocus] = useState<"search" | "list" | "messages" | "composer">("list");
  const [draft, setDraft] = useState("");
  const searchInput = useRef<InputRenderable>(null);
  const composer = useRef<TextareaRenderable>(null);
  const compact = panel.rect.width < 76;
  const showList = !compact || focus === "list";
  const showDetail = !compact || focus !== "list";
  const sidebarWidth = compact ? panel.rect.width - 2 : getPaneSidebarWidth(panel.rect.width);

  useActionShortcut({
    chord: "j",
    action: handles.moveChat,
    input: { offset: 1 },
    enabled: focus === "list",
  });
  useActionShortcut({
    chord: "k",
    action: handles.moveChat,
    input: { offset: -1 },
    enabled: focus === "list",
  });
  useActionShortcut({
    chord: "j",
    action: handles.moveMessage,
    input: { offset: 1 },
    enabled: focus === "messages",
  });
  useActionShortcut({
    chord: "k",
    action: handles.moveMessage,
    input: { offset: -1 },
    enabled: focus === "messages",
  });
  useShortcut((event) => {
    if (event.name === "tab") {
      setFocus((current) =>
        current === "list" ? "messages" : current === "messages" ? "composer" : "list",
      );
      event.preventDefault();
    } else if (event.name === "escape" && focus !== "list") {
      setFocus(focus === "search" || compact ? "list" : "messages");
    } else if (event.name === "i" && focus !== "composer") {
      setFocus("composer");
      composer.current?.focus();
      event.preventDefault();
    } else if (event.name === "/" && focus !== "search") {
      setFocus("search");
      searchInput.current?.focus();
      event.preventDefault();
    } else if (event.name === "return" && focus === "list" && snapshot.section === "chats") {
      setFocus("messages");
      event.preventDefault();
    }
  });
  useKeyHints([
    { key: "j/k", label: "move" },
    { key: "i", label: "compose" },
    { key: "/", label: "search" },
  ]);

  const list =
    snapshot.section === "chats"
      ? snapshot.chats
      : snapshot.section === "contacts"
        ? snapshot.contacts
        : snapshot.groups;
  const submitDraft = async (): Promise<void> => {
    const input = draft.trim();
    if (!input) return;
    const result = await actions.invoke(handles.submit, { input }, humanUiContext);
    if (result.ok) {
      setDraft("");
      composer.current?.clear();
    }
  };

  return (
    <PaneFrame
      title={`${snapshot.phase} · ${snapshot.account}`}
      width={panel.rect.width}
      height={panel.rect.height}
      focused={panel.focused}
      onActionMouseDown={() => undefined}
    >
      <box flexDirection="column" width="100%" height="100%" backgroundColor={theme.bg}>
        <box
          height={3}
          paddingX={1}
          gap={compact ? 0 : 2}
          borderStyle="single"
          borderColor={theme.border}
        >
          {compact ? (
            <text fg={theme.textBright}>{snapshot.section} · Ctrl+P sections</text>
          ) : (
            (["chats", "contacts", "groups"] as const).map((section) => (
              <box
                key={section}
                paddingX={1}
                backgroundColor={snapshot.section === section ? theme.selected : theme.panel}
                onMouseDown={() =>
                  void actions.invoke(handles.setSection, { section }, humanPointerContext)
                }
              >
                <text fg={snapshot.section === section ? theme.selectedText : theme.text}>
                  {section}
                </text>
              </box>
            ))
          )}
          {!compact && (
            <text fg={theme.textDim}>
              {snapshot.query ? `filter: ${snapshot.query}` : "Ctrl+P for search/actions"}
            </text>
          )}
        </box>
        <box
          height={3}
          borderStyle="single"
          borderColor={focus === "search" ? theme.borderFocused : theme.border}
        >
          <input
            ref={searchInput}
            flexGrow={1}
            focused={focus === "search"}
            placeholder={
              snapshot.query ? `Filter: ${snapshot.query}` : "Search current section · /"
            }
            onSubmit={() => {
              void actions.invoke(
                handles.search,
                { query: searchInput.current?.value ?? "" },
                humanUiContext,
              );
              setFocus("list");
            }}
          />
        </box>
        <box flexDirection="row" flexGrow={1}>
          {showList && (
            <PaneSidebar
              width={sidebarWidth}
              height={Math.max(4, panel.rect.height - 10)}
              focused={panel.focused}
              keyboardFocused={focus === "list"}
              label={snapshot.section}
            >
              {list.map((entry) => {
                const active = "preview" in entry ? entry.id === snapshot.selectedChatId : false;
                const label =
                  "preview" in entry
                    ? `${entry.isGroup ? "# " : ""}${entry.name} · ${entry.preview}${entry.canSend ? "" : " · read-only"}`
                    : `${entry.name} · ${(entry as TerminalDirectoryEntry).detail}`;
                return (
                  <PaneSidebarRow
                    key={entry.id}
                    active={active}
                    label={label}
                    role={snapshot.section.slice(0, -1)}
                    onSelect={() => {
                      if (snapshot.section !== "chats") return;
                      void actions.invoke(
                        handles.selectChat,
                        { chatId: entry.id },
                        humanPointerContext,
                      );
                      setFocus("messages");
                    }}
                  />
                );
              })}
            </PaneSidebar>
          )}
          {showDetail && (
            <box flexDirection="column" flexGrow={1} minWidth={20}>
              {snapshot.section === "chats" ? (
                <>
                  <box
                    height={2}
                    paddingX={1}
                    justifyContent="space-between"
                    backgroundColor={theme.header}
                  >
                    <text fg={theme.headerText}>
                      {snapshot.selectedChatName ?? "No chat selected"}
                    </text>
                    <text fg={theme.textDim}>
                      {snapshot.messages
                        .map((message) => message.status)
                        .filter(Boolean)
                        .join(" · ") ||
                        (snapshot.older === "exhausted" ? "saved start" : snapshot.older)}
                    </text>
                  </box>
                  <scrollbox
                    height={Math.max(4, panel.rect.height - 14)}
                    padding={1}
                    focused={focus === "messages"}
                  >
                    {snapshot.messages.map((message) => {
                      const active = message.id === snapshot.selectedMessageId;
                      return (
                        <box
                          key={message.id}
                          flexDirection="column"
                          marginBottom={1}
                          paddingX={1}
                          backgroundColor={
                            active ? theme.selected : message.fromMe ? theme.commandBg : theme.panel
                          }
                        >
                          <text fg={active ? theme.selectedText : theme.textBright}>
                            {message.author} · {message.kind}
                          </text>
                          <text fg={active ? theme.selectedText : theme.text}>{message.body}</text>
                          <text fg={active ? theme.selectedText : theme.textDim}>
                            {[
                              ...message.metadata,
                              ...message.reactions,
                              message.status,
                              message.detail,
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </text>
                        </box>
                      );
                    })}
                  </scrollbox>
                  {snapshot.error && <text fg={theme.negative}>error · {snapshot.error}</text>}
                  <MessageComposer
                    inputRef={composer}
                    initialValue=""
                    focused={focus === "composer"}
                    identity="You"
                    placeholder="Message or /command"
                    width={Math.max(20, panel.rect.width - (showList ? sidebarWidth : 0) - 2)}
                    onFocusRequest={() => setFocus("composer")}
                    onInput={(value) => setDraft(value)}
                    onSubmit={() => void submitDraft()}
                  />
                </>
              ) : (
                <box padding={2} flexDirection="column">
                  <text fg={theme.textBright}>{snapshot.section}</text>
                  <text fg={theme.textDim}>
                    {snapshot.section === "contacts"
                      ? "Contacts contain WhatsApp Addresses, not groups; avatar means the SDK supplied an image URL."
                      : "Unknown rosters stay unknown. Use the typed group action for metadata or guarded mutations."}
                  </text>
                </box>
              )}
            </box>
          )}
        </box>
      </box>
    </PaneFrame>
  );
}
