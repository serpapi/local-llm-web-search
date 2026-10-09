import { defineConfig } from "vite"
import { devtools } from "@tanstack/devtools-vite"
import { tanstackStart } from "@tanstack/react-start/plugin/vite"
import viteReact from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { nitro } from "nitro/vite"

const config = defineConfig({
  // Vite 8 resolves tsconfig `paths` natively, so the `@/*` alias needs no
  // extra plugin here (vitest.config.ts mirrors this).
  resolve: { tsconfigPaths: true },
  plugins: [
    devtools(),
    tailwindcss(),
    tanstackStart({
      // WHY: the SDKs that hold the SerpApi key, talk to LM Studio and load
      //      the 5 MB tokenizer table must never reach the browser. On top
      //      of the default `*.server.*` rule, a client import of them
      //      fails the build (after tree-shaking) instead of shipping.
      importProtection: {
        client: { specifiers: [/^(serpapi|openai|js-tiktoken)(\/|$)/] },
      },
    }),
    // WHY: react's plugin MUST come after tanstackStart(), and nitro (the
    //      server runtime) comes last, the order TanStack Start's docs use.
    viteReact(),
    nitro(),
  ],
})

export default config
