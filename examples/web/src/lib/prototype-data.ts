export type PrototypeChat = {
  id: string;
  name: string;
  initials: string;
  preview: string;
  time: string;
  unread?: number;
  group?: boolean;
  online?: boolean;
};

export type PrototypeMessage = {
  id: string;
  fromMe: boolean;
  sender: string;
  time: string;
  text?: string;
  attachment?: {
    filename: string;
    mediaType: string;
    url: string;
  };
  reactions?: readonly { emoji: string; count: number; mine?: boolean }[];
  receipt?: "queued" | "sent" | "delivered" | "read" | "played";
  operation?: "executing" | "failed" | "outcome_unknown";
};

export const prototypeChats: readonly PrototypeChat[] = [
  {
    id: "studio",
    name: "Product studio",
    initials: "PS",
    preview: "Maya: The voice note playback works now",
    time: "10:42",
    unread: 4,
    group: true,
  },
  {
    id: "maya",
    name: "Maya Chen",
    initials: "MC",
    preview: "Can we ship the onboarding flow today?",
    time: "09:18",
    online: true,
  },
  {
    id: "launch",
    name: "Launch crew",
    initials: "LC",
    preview: "You: Uploaded release-checklist.pdf",
    time: "Yesterday",
    unread: 1,
    group: true,
  },
  {
    id: "sam",
    name: "Sam Rivera",
    initials: "SR",
    preview: "That reaction state is much clearer",
    time: "Friday",
  },
];

export const prototypeMessages: readonly PrototypeMessage[] = [
  {
    id: "m1",
    fromMe: false,
    sender: "Maya",
    time: "10:34",
    text: "The pairing screen is calm now. It explains why the QR changes instead of making it feel broken.",
    reactions: [{ emoji: "💚", count: 3, mine: true }],
  },
  {
    id: "m2",
    fromMe: true,
    sender: "You",
    time: "10:37",
    text: "Good. I also separated saved-history paging from asking the phone for older messages.",
    receipt: "read",
  },
  {
    id: "m3",
    fromMe: false,
    sender: "Dara",
    time: "10:40",
    attachment: {
      filename: "conversation-layout.png",
      mediaType: "image/svg+xml",
      url: "/prototype-attachment.svg",
    },
    text: "This is the denser layout on a laptop.",
    reactions: [
      { emoji: "🔥", count: 2 },
      { emoji: "👀", count: 1 },
    ],
  },
  {
    id: "m4",
    fromMe: true,
    sender: "You",
    time: "10:41",
    text: "Uploading the final voice note…",
    receipt: "queued",
    operation: "executing",
  },
  {
    id: "m5",
    fromMe: true,
    sender: "You",
    time: "10:42",
    text: "The previous send may have reached WhatsApp. I am checking before retrying.",
    operation: "outcome_unknown",
  },
];

export const prototypeOperations = [
  { label: "Queued", value: 2, tone: "secondary" as const },
  { label: "Executing", value: 1, tone: "default" as const },
  { label: "Needs attention", value: 1, tone: "destructive" as const },
];

export const prototypeQrValue =
  "whatsappd-interface-prototype-not-a-real-whatsapp-pairing-challenge";
