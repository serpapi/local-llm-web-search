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
    tanstackStart(),
    // WHY: react's plugin MUST come after tanstackStart(), and nitro (the
    //      server runtime) comes last, the order TanStack Start's docs use.
    viteReact(),
    nitro(),
  ],
})

export default config
