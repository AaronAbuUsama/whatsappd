import {
  createSession,
  createWhatsAppClient,
  createWhatsAppRuntime,
  memoryBackend,
  qrAuth,
} from "whatsappd";

const backend = memoryBackend();
const runtime = createWhatsAppRuntime({
  accountId: "primary",
  backend,
  openSession(store) {
    const session = createSession({ auth: qrAuth(), store });
    session.subscribe({
      connection(status) {
        if (status.phase === "pairing" && status.pairing.step === "challenge_live") {
          console.log(status.pairing.qr);
        }
      },
    });
    return session;
  },
});

await runtime.start();
const client = await createWhatsAppClient(runtime);
const unsubscribe = client.chats.subscribe(() => {
  console.log(client.chats.list());
});

try {
  console.log(client.account.get());
} finally {
  unsubscribe();
  await client.close();
  await runtime.stop();
}
