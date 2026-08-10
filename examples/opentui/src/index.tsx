import { runTuiApp } from "agentic-tui-kit";
import { createWhatsAppTui } from "./app.tsx";
import { createTerminalWorker } from "./whatsapp.ts";

const worker = await createTerminalWorker();
await runTuiApp(createWhatsAppTui(worker.application, () => void worker.close()));
