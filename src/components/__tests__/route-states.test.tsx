import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import {
  QueryClient,
  QueryClientProvider,
  useSuspenseQuery,
} from "@tanstack/react-query"
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router"

import { RouteError } from "@/components/route-states"

// The router's default error screen, for a page that reads its data with
// useSuspenseQuery and no loader to fetch it again.

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function renderFailingPage() {
  const queryFn = vi
    .fn<() => Promise<string>>()
    .mockRejectedValueOnce(new Error("LM Studio went away"))
    .mockResolvedValue("Loaded again")

  function Page() {
    const { data } = useSuspenseQuery({
      queryKey: ["page"],
      queryFn,
      retry: false,
    })
    return <p>{data}</p>
  }

  const rootRoute = createRootRoute({ component: Outlet })
  const pageRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: Page,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([pageRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
    defaultErrorComponent: RouteError,
  })
  // Silence React's report of the error the boundary catches.
  vi.spyOn(console, "error").mockImplementation(() => {})

  render(
    <QueryClientProvider client={new QueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  )
  return queryFn
}

describe("RouteError", () => {
  it("fetches a failed suspense query again on Try again", async () => {
    const queryFn = renderFailingPage()

    expect(await screen.findByText("Something broke")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Try again" }))

    expect(await screen.findByText("Loaded again")).toBeTruthy()
    expect(queryFn).toHaveBeenCalledTimes(2)
  })
})
