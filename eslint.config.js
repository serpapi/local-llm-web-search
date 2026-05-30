//  @ts-check

import { tanstackConfig } from "@tanstack/eslint-config"

export default [
  {
    ignores: [
      ".output/**",
      ".nitro/**",
      ".tanstack/**",
      "dist/**",
      "node_modules/**",
      "src/routeTree.gen.ts",
    ],
  },
  ...tanstackConfig,
]
