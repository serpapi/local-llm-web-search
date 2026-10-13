//  @ts-check

import pluginRouter from "@tanstack/eslint-plugin-router"
import { tanstackConfig } from "@tanstack/eslint-config"

// Classes that redefine a shadcn primitive's size, shape, or type from the
// call site. Every Button reads its height, radius, font size, and weight
// from `size` and `variant`; overriding them per instance is how three
// controls in one row ended up with three different styles. Add a variant
// to the primitive instead. Menu and popover triggers are Buttons too.
const PRIMITIVE_OVERRIDES =
  /(^|\s)(h-\d+|h-auto|h-\[|min-h-|rounded(-\w+)?|text-(xs|sm|base|lg|\[)|font-(normal|medium|semibold|bold|mono|sans))(\s|$)/

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
  {
    files: ["src/**/*.tsx"],
    ignores: ["src/components/ui/**"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: `JSXOpeningElement[name.name="Button"] > JSXAttribute[name.name="className"] > Literal[value=${PRIMITIVE_OVERRIDES}]`,
          message:
            "Do not override a Button's height, radius, font size, or weight from the call site. Pick a `size`/`variant`, or add one in src/components/ui/button.tsx.",
        },
      ],
    },
  },
]
