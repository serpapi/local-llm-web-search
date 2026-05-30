import { Component } from "react"
import type { ErrorInfo, ReactNode } from "react"

type ErrorBoundaryProps = {
  children: ReactNode
}

type ErrorBoundaryState = {
  error: Error | null
}

export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[ErrorBoundary]", error, info.componentStack)
  }

  handleReload = () => {
    window.location.reload()
  }

  render() {
    if (this.state.error !== null) {
      return (
        <div
          role="alert"
          className="flex min-h-svh items-center justify-center bg-muted/40 p-6"
        >
          <div className="flex max-w-lg flex-col gap-4 rounded-xl border bg-background p-6 shadow-sm">
            <h1 className="text-lg font-semibold">Something broke</h1>
            <p className="text-sm text-muted-foreground">
              The app hit an error it couldn&apos;t recover from. Reloading
              usually fixes it.
            </p>
            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground">
                Technical details
              </summary>
              <pre className="mt-2 overflow-x-auto rounded-md bg-muted p-3 font-mono">
                {this.state.error.message}
              </pre>
            </details>
            <button
              type="button"
              onClick={this.handleReload}
              className="self-start rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted"
            >
              Reload
            </button>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}
