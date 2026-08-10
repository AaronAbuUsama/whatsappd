import type { ClientSubscribeOptions, WhatsAppClient } from "whatsappd";

export function subscribeWhatsAppClient(
  client: WhatsAppClient,
  listener: () => void,
  options?: ClientSubscribeOptions,
): () => void {
  const subscriptions = [
    client.account.subscribe(listener, options),
    client.chats.subscribe(listener, options),
    client.contacts.subscribe(listener, options),
    client.groups.subscribe(listener, options),
    client.messages.subscribe(listener, options),
  ];
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    for (const unsubscribe of subscriptions) unsubscribe();
  };
}
