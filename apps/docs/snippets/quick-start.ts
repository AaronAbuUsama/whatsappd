import { createSession, fileStore, qrAuth } from "whatsappd";

const session = createSession({
  auth: qrAuth(),
  store: fileStore("./.wa-auth"),
});

const unsubscribe = session.subscribe({
  connection(status) {
    console.log(status.phase);
  },
});

try {
  await session.start();
} finally {
  unsubscribe();
  await session.stop();
}
