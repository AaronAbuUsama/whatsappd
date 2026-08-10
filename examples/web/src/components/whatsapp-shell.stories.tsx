import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, userEvent } from "storybook/test";
import { WhatsAppShell } from "@/components/whatsapp-shell";
import {
  createStateLabBrowser,
  STATE_LAB_VIEWS,
  stateLabConversation,
  stateLabDirectory,
} from "@/components/whatsapp-state-lab";
import type {
  WhatsAppApplicationCommand,
  WhatsAppApplicationView,
} from "@/lib/whatsapp-application";
import "@/app/globals.css";

const meta = {
  title: "WhatsApp/State lab",
  component: WhatsAppShell,
  parameters: { a11y: { test: "error" } },
} satisfies Meta<typeof WhatsAppShell>;

export default meta;
type Story = StoryObj<typeof meta>;

export const DesktopDirectory: Story = {
  args: { browser: createStateLabBrowser(stateLabDirectory) },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("heading", { name: "Chats" })).toBeVisible();
    const search = canvas.getByRole("searchbox", { name: "Search chats" });
    await userEvent.type(search, "Aster");
    await expect(canvas.getByText("Aster Garden")).toBeVisible();
    await expect(canvas.queryByText("Beacon Workshop")).not.toBeInTheDocument();
  },
};

export const MobileSelection: Story = {
  globals: { viewport: { value: "mobile1", isRotated: false } },
  args: { browser: createStateLabBrowser(stateLabDirectory) },
  play: async ({ canvas }) => {
    await userEvent.click(canvas.getByRole("button", { name: /Beacon Workshop/ }));
    await expect(canvas.getByRole("heading", { name: "Beacon Workshop" })).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Back to chats" }));
    await expect(canvas.getByRole("heading", { name: "Chats" })).toBeVisible();
    await userEvent.click(canvas.getByLabelText("Contacts"));
    await expect(canvas.getByRole("heading", { name: "Contacts" })).toBeVisible();
    await userEvent.click(canvas.getByLabelText("Groups"));
    await expect(canvas.getByRole("heading", { name: "Groups" })).toBeVisible();
    await userEvent.click(canvas.getByLabelText("Settings"));
    await expect(canvas.getByRole("heading", { name: "Settings" })).toBeVisible();
  },
};

export const DesktopConversationMatrix: Story = {
  args: { browser: createStateLabBrowser(stateLabConversation) },
};

export const MobileConversationMatrix: Story = {
  globals: { viewport: { value: "mobile1", isRotated: false } },
  args: { browser: createStateLabBrowser(stateLabConversation) },
};

const interactionCommands: WhatsAppApplicationCommand[] = [];
const interactionBrowser = createStateLabBrowser(stateLabConversation, interactionCommands);

export const ConversationInteractions: Story = {
  args: { browser: interactionBrowser },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("heading", { name: "Beacon Workshop" })).toBeVisible();
    interactionCommands.length = 0;

    await userEvent.click(canvas.getByRole("button", { name: "👍 2" }));
    await expect(interactionCommands.some(({ type }) => type === "unreact")).toBe(true);

    await userEvent.click(canvas.getByRole("button", { name: "Load older saved messages" }));
    await expect(interactionCommands.some(({ type }) => type === "load_older")).toBe(true);

    const composer = canvas.getByRole("textbox", { name: "Message" });
    await userEvent.type(composer, "Invented composer message");
    await userEvent.click(canvas.getByRole("button", { name: "Send" }));
    await expect(interactionCommands.some(({ type }) => type === "send_text")).toBe(true);
  },
};

const storyFor = (view: WhatsAppApplicationView): Story => ({
  args: { browser: createStateLabBrowser(view) },
});
const mobileStoryFor = (view: WhatsAppApplicationView): Story => ({
  ...storyFor(view),
  globals: { viewport: { value: "mobile1", isRotated: false } },
});

export const ConnectionDisconnected = storyFor(STATE_LAB_VIEWS.connections.disconnected);
export const ConnectionConnecting = storyFor(STATE_LAB_VIEWS.connections.connecting);
export const ConnectionPairing = storyFor(STATE_LAB_VIEWS.connections.pairing);
export const ConnectionAuthenticated = storyFor(STATE_LAB_VIEWS.connections.authenticated);
export const ConnectionOnline = storyFor(STATE_LAB_VIEWS.connections.online);
export const ConnectionBackingOff = storyFor(STATE_LAB_VIEWS.connections.backing_off);
export const ConnectionLoggedOut = storyFor(STATE_LAB_VIEWS.connections.logged_out);
export const ConnectionSuspended = storyFor(STATE_LAB_VIEWS.connections.suspended);
export const ConnectionStale = storyFor(STATE_LAB_VIEWS.connections.stale);
export const ConnectionClosed = storyFor(STATE_LAB_VIEWS.connections.closed);
export const MobileConnectionDisconnected = mobileStoryFor(
  STATE_LAB_VIEWS.connections.disconnected,
);
export const MobileConnectionConnecting = mobileStoryFor(STATE_LAB_VIEWS.connections.connecting);
export const MobileConnectionPairing = mobileStoryFor(STATE_LAB_VIEWS.connections.pairing);
export const MobileConnectionAuthenticated = mobileStoryFor(
  STATE_LAB_VIEWS.connections.authenticated,
);
export const MobileConnectionOnline = mobileStoryFor(STATE_LAB_VIEWS.connections.online);
export const MobileConnectionBackingOff = mobileStoryFor(STATE_LAB_VIEWS.connections.backing_off);
export const MobileConnectionLoggedOut = mobileStoryFor(STATE_LAB_VIEWS.connections.logged_out);
export const MobileConnectionSuspended = mobileStoryFor(STATE_LAB_VIEWS.connections.suspended);
export const MobileConnectionStale = mobileStoryFor(STATE_LAB_VIEWS.connections.stale);
export const MobileConnectionClosed = mobileStoryFor(STATE_LAB_VIEWS.connections.closed);

export const PagingStored = storyFor(STATE_LAB_VIEWS.paging.stored);
export const PagingLoading = storyFor(STATE_LAB_VIEWS.paging.loading);
export const PagingExhausted = storyFor(STATE_LAB_VIEWS.paging.exhausted);
export const PagingError = storyFor(STATE_LAB_VIEWS.paging.error);
export const MobilePagingStored = mobileStoryFor(STATE_LAB_VIEWS.paging.stored);
export const MobilePagingLoading = mobileStoryFor(STATE_LAB_VIEWS.paging.loading);
export const MobilePagingExhausted = mobileStoryFor(STATE_LAB_VIEWS.paging.exhausted);
export const MobilePagingError = mobileStoryFor(STATE_LAB_VIEWS.paging.error);
