//  @ts-check

import pluginRouter from "@tanstack/eslint-plugin-router"
import { tanstackConfig } from "@tanstack/eslint-config"

export default [
  {
    ignores: [
      ".output/**",
      ".nitro/**",
      ".tanstack/**",
      "dist/**",
      // Local working notes and scratch scripts (gitignored).
      "docs/**",
      "node_modules/**",
      "src/routeTree.gen.ts",
    ],
  },
  ...tanstackConfig,
  ...pluginRouter.configs["flat/recommended"],
]
