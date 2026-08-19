import {
  convexBackend,
  createSession,
  createWhatsAppRuntime,
  fileMediaStore,
  qrAuth,
} from "whatsappd";

// The deployment the account's durable state lives in. A local deployment
// (`npx convex dev`) is a URL like this one; a cloud deployment is its
// `.convex.cloud` URL. Media bytes stay out of it -- durable media is its own
// capability, and here it is the filesystem.
const backend = convexBackend({
  url: process.env.CONVEX_URL ?? "http://127.0.0.1:3210",
  accountId: "primary",
  media: fileMediaStore({ directory: "./whatsapp-media" }),
});

const runtime = createWhatsAppRuntime({
  accountId: "primary",
  backend,
  openSession: (store) => createSession({ auth: qrAuth(), store }),
});

await runtime.start();
try {
  console.log((await runtime.snapshot()).chats.length);
} finally {
  await runtime.stop();
  await backend.close();
}
