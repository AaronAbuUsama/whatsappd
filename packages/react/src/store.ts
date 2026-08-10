import {
  createContext,
  createElement,
  useContext,
  useSyncExternalStore,
  type ReactNode,
} from "react";

export type WhatsAppStore<Snapshot> = {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => Snapshot;
  readonly getServerSnapshot?: () => Snapshot;
};

export type WhatsAppProviderProps<Store> = {
  readonly store: Store;
  readonly children?: ReactNode;
};

export type WhatsAppBindings<Snapshot, Store extends WhatsAppStore<Snapshot>> = {
  readonly WhatsAppProvider: (props: WhatsAppProviderProps<Store>) => ReactNode;
  readonly useWhatsAppStore: () => Store;
  readonly useWhatsAppSnapshot: () => Snapshot;
};

export function createWhatsAppBindings<
  Snapshot,
  Store extends WhatsAppStore<Snapshot> = WhatsAppStore<Snapshot>,
>(): WhatsAppBindings<Snapshot, Store> {
  const StoreContext = createContext<Store | undefined>(undefined);

  const useWhatsAppStore = (): Store => {
    const store = useContext(StoreContext);
    if (!store) throw new Error("WhatsApp hooks must be used inside WhatsAppProvider");
    return store;
  };
  const useWhatsAppSnapshot = (): Snapshot => {
    const store = useWhatsAppStore();
    return useSyncExternalStore(
      store.subscribe,
      store.getSnapshot,
      store.getServerSnapshot ?? store.getSnapshot,
    );
  };
  const WhatsAppProvider = ({ store, children }: WhatsAppProviderProps<Store>): ReactNode =>
    createElement(StoreContext.Provider, { value: store }, children);

  return { WhatsAppProvider, useWhatsAppStore, useWhatsAppSnapshot };
}
