import {
  HeadContent,
  ScriptOnce,
  Scripts,
  createRootRouteWithContext,
} from "@tanstack/react-router"
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools"
import { ReactQueryDevtoolsPanel } from "@tanstack/react-query-devtools"
import { TanStackDevtools } from "@tanstack/react-devtools"

import appCss from "../styles.css?url"
import type { QueryClient } from "@tanstack/react-query"

import { CommandMenu } from "@/components/command-menu"
import { NotFound } from "@/components/route-states"
import { ThemeProvider } from "@/components/theme-provider"
import { Toaster } from "@/components/ui/sonner"
import { THEME_STORAGE_KEY } from "@/hooks/use-theme"

// WHY: the theme lives in localStorage, which the server can't read. This
//      runs from the server HTML before React hydrates and puts `dark` on
//      <html>, so a dark-mode user never sees a white flash. `ScriptOnce`
//      renders it on the server only, and the script removes itself.
const THEME_BOOT_SCRIPT = `try{var t=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});if(t==="dark"||(t!=="light"&&matchMedia("(prefers-color-scheme: dark)").matches))document.documentElement.classList.add("dark")}catch(e){}`

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()(
  {
    head: () => ({
      meta: [
        { charSet: "utf-8" },
        { name: "viewport", content: "width=device-width, initial-scale=1" },
        { title: "SerpApi Local Agent Lab" },
        {
          name: "description",
          content:
            "Give a local LLM real-time web data. The model picks a SerpApi tool, the server runs it, and the answer arrives with fresh results and sources.",
        },
        { name: "color-scheme", content: "light dark" },
        {
          name: "theme-color",
          media: "(prefers-color-scheme: light)",
          content: "#ffffff",
        },
        {
          name: "theme-color",
          media: "(prefers-color-scheme: dark)",
          content: "#252525",
        },
        { property: "og:type", content: "website" },
        { property: "og:title", content: "SerpApi Local Agent Lab" },
        {
          property: "og:description",
          content:
            "Real-time web search for a local LLM through SerpApi function calling.",
        },
        { property: "og:image", content: "/icon-512.png" },
        { name: "twitter:card", content: "summary" },
      ],
      links: [
        { rel: "stylesheet", href: appCss },
        { rel: "icon", href: "/serpapi-logo.svg", type: "image/svg+xml" },
        {
          rel: "icon",
          href: "/favicon-32.png",
          type: "image/png",
          sizes: "32x32",
        },
        {
          rel: "apple-touch-icon",
          href: "/apple-touch-icon.png",
          sizes: "180x180",
        },
        { rel: "manifest", href: "/manifest.json" },
      ],
    }),
    shellComponent: RootDocument,
    notFoundComponent: NotFound,
  }
)

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    // WHY: the theme script adds `dark` to <html> before hydration, so the
    //      class differs from the server's on purpose.
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body>
        <ScriptOnce children={THEME_BOOT_SCRIPT} />
        <ThemeProvider>
          {children}
          <CommandMenu />
          <Toaster />
        </ThemeProvider>
        <TanStackDevtools
          config={{ position: "bottom-right" }}
          plugins={[
            {
              name: "TanStack Router",
              render: <TanStackRouterDevtoolsPanel />,
            },
            { name: "TanStack Query", render: <ReactQueryDevtoolsPanel /> },
          ]}
        />
        <Scripts />
      </body>
    </html>
  )
}
