import { useQueryErrorResetBoundary } from "@tanstack/react-query"
import { Link, useRouter } from "@tanstack/react-router"
import { ArrowLeft, SearchX } from "lucide-react"
import { useEffect } from "react"

import type { ErrorComponentProps } from "@tanstack/react-router"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"

/** Shown for any URL that no route matches. */
export function NotFound() {
  return (
    <main className="flex min-h-svh items-center justify-center bg-muted/40 p-6">
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <SearchX aria-hidden />
          </EmptyMedia>
          <EmptyTitle>Page not found</EmptyTitle>
          <EmptyDescription>
            This address does not match a page.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button asChild variant="outline">
            <Link to="/">
              <ArrowLeft data-icon="inline-start" aria-hidden />
              Back to chat
            </Link>
          </Button>
        </EmptyContent>
      </Empty>
    </main>
  )
}

/**
 * Shown when a route's loader or component throws. Set as the router's
 * `defaultErrorComponent`, so it renders inside the root shell.
 */
export function RouteError({ error }: ErrorComponentProps) {
  const router = useRouter()
  const queryErrorResetBoundary = useQueryErrorResetBoundary()
  // WHY: the pages read their data with useSuspenseQuery, which throws a
  //      failed query's error again until Query's error boundary is reset.
  //      Resetting it here lets Try again, or a later visit, fetch anew.
  useEffect(() => {
    queryErrorResetBoundary.reset()
  }, [queryErrorResetBoundary])
  return (
    <div
      role="alert"
      className="flex min-h-svh items-center justify-center bg-muted/40 p-6"
    >
      <div className="flex max-w-lg flex-col gap-4 rounded-xl border bg-background p-6 shadow-sm">
        <h1 className="text-lg font-semibold">Something broke</h1>
        <p className="text-sm text-muted-foreground">
          The app hit an error it couldn&apos;t recover from. Try again, or
          reload the page if it keeps happening.
        </p>
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">
            Technical details
          </summary>
          <pre className="mt-2 overflow-x-auto rounded-md bg-muted p-3 font-mono">
            {error instanceof Error ? error.message : String(error)}
          </pre>
        </details>
        <div className="flex gap-2">
          {/* WHY: invalidate, not reset. It reruns the loaders and resets
                   the boundary, so a failed load is retried too. */}
          <Button type="button" onClick={() => void router.invalidate()}>
            Try again
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => window.location.reload()}
          >
            Reload page
          </Button>
        </div>
      </div>
    </div>
  )
}

/** Placeholder layout while a route loader is still running. */
export function PagePending() {
  return (
    <div
      role="status"
      aria-label="Loading page"
      className="min-h-svh bg-muted/40"
    >
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-6">
        <div className="flex items-center gap-3">
          <Skeleton className="size-10 rounded-lg" />
          <div className="flex flex-col gap-2">
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-3 w-64" />
          </div>
        </div>
        <Skeleton className="h-48 w-full rounded-xl" />
        <Skeleton className="h-96 w-full rounded-xl" />
      </div>
    </div>
  )
}
