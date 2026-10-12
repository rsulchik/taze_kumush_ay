import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { queryGcTimeMs, queryStaleTimeMs } from "@/lib/query-persist";
import { routeTree } from "./routeTree.gen";

export const getRouter = () => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: queryStaleTimeMs,
        gcTime: queryGcTimeMs,
        refetchOnWindowFocus: false,
        networkMode: "offlineFirst",
        retry: 1,
      },
      mutations: {
        networkMode: "offlineFirst",
      },
    },
  });

  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    defaultPreloadStaleTime: 0,
  });

  return router;
};
