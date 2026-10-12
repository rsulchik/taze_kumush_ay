import { useEffect, useState } from "react";
import { QueryClient, QueryClientProvider, useIsRestoring, useQueryClient } from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { prefetchCatalog } from "@/lib/catalog";
import { startOfflineSync } from "@/lib/offline/sync";
import { queryPersistOptions } from "@/lib/query-persist";

type QueryProviderProps = {
  client: QueryClient;
  children: React.ReactNode;
};

function CatalogPrefetch() {
  const queryClient = useQueryClient();
  const isRestoring = useIsRestoring();

  useEffect(() => {
    if (isRestoring) return;
    const stop = startOfflineSync(queryClient);
    void prefetchCatalog(queryClient);
    return stop;
  }, [isRestoring, queryClient]);

  return null;
}

function PersistGate({ children }: { children: React.ReactNode }) {
  const isRestoring = useIsRestoring();
  if (isRestoring) {
    return <div className="p-8 text-muted-foreground">Загрузка...</div>;
  }
  return (
    <>
      <CatalogPrefetch />
      {children}
    </>
  );
}

export function QueryProvider({ client, children }: QueryProviderProps) {
  const [isClient, setIsClient] = useState(false);

  useEffect(() => {
    setIsClient(true);
  }, []);

  if (!isClient) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }

  return (
    <PersistQueryClientProvider client={client} persistOptions={queryPersistOptions}>
      <PersistGate>{children}</PersistGate>
    </PersistQueryClientProvider>
  );
}
