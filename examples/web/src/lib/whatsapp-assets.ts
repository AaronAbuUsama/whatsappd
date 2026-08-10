import type { WhatsAppAssetSources } from "@/lib/whatsappd/whatsapp-assets";

export const whatsappAssetSources: WhatsAppAssetSources = {
  avatar: (token) => `/api/avatar/${encodeURIComponent(token)}`,
  media: (token) => `/api/media/${encodeURIComponent(token)}`,
};
