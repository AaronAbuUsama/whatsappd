# @whatsappd/react

Renderer-neutral React bindings for `whatsappd`. The package renders no DOM or terminal nodes.

```tsx
import { createWhatsAppBindings, type WhatsAppStore } from "@whatsappd/react";

type Snapshot = { phase: string };
const { WhatsAppProvider, useWhatsAppSnapshot } = createWhatsAppBindings<Snapshot>();

function AccountState() {
  const snapshot = useWhatsAppSnapshot();
  return snapshot.phase;
}

export function App({ store }: { store: WhatsAppStore<Snapshot> }) {
  return (
    <WhatsAppProvider store={store}>
      <AccountState />
    </WhatsAppProvider>
  );
}
```

The generated `WhatsAppProvider` and hooks retain the store's exact snapshot type. The Provider follows the supplied store with React's external-store contract. Replacing or unmounting it releases only that React subscription; it never closes the application-owned Client, Runtime, Backend, browser transport, or terminal application.

Use `subscribeWhatsAppClient(client, listener)` when a renderer-neutral store needs one notification from any public Client namespace. Selection, scrolling, transport, authorization, and presentation remain application-owned.
