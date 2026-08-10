"use client";

import { createContext, useContext, type ReactNode } from "react";

export type WhatsAppAssetSources = {
  readonly avatar: (token: string) => string;
  readonly media: (token: string) => string;
};

const identity = (source: string): string => source;
const WhatsAppAssets = createContext<WhatsAppAssetSources>({ avatar: identity, media: identity });

export function WhatsAppAssetProvider({
  sources,
  children,
}: {
  readonly sources?: WhatsAppAssetSources;
  readonly children: ReactNode;
}) {
  return (
    <WhatsAppAssets value={sources ?? { avatar: identity, media: identity }}>
      {children}
    </WhatsAppAssets>
  );
}

export const useWhatsAppAssetSources = (): WhatsAppAssetSources => useContext(WhatsAppAssets);
