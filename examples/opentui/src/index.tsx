import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { WhatsAppTui } from "./app.tsx";
import { createTerminalWorker } from "./whatsapp.ts";

const worker = await createTerminalWorker();
const renderer = await createCliRenderer({ exitOnCtrlC: false });
const root = createRoot(renderer);
let closing = false;

renderer.once("destroy", () => {
  if (closing) return;
  closing = true;
  root.unmount();
  void worker.close();
});

root.render(<WhatsAppTui application={worker.application} />);
