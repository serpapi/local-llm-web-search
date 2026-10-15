import { QueryClient } from "@tanstack/react-query"
import { createRouter as createTanStackRouter } from "@tanstack/react-router"
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query"
import { routeTree } from "./routeTree.gen"

import { RouteError } from "@/components/route-states"

export function getRouter() {
  // WHY: one client per router. Start builds a router per SSR request, so a
  //      module-level client would serve one browser's chat to another.
  const queryClient = new QueryClient({
    defaultOptions: {
      // WHY: the server just rendered this data, so the browser doesn't
      //      read it again on hydration. Polling keeps a running turn
      //      current; a refocused tab refetches once this has passed.
      queries: { staleTime: 30_000 },
    },
  })

  const router = createTanStackRouter({
    routeTree,
    context: { queryClient },

    scrollRestoration: true,
    defaultPreload: "intent",
    // WHY: Query decides whether a preload needs fresh data. The /bench
    //      loader reads the job with `staleTime: 0`, so Query fetches it
    //      again on every preload and visit.
    defaultPreloadStaleTime: 0,
    defaultErrorComponent: RouteError,
  })

  setupRouterSsrQueryIntegration({ router, queryClient })

  return router
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
