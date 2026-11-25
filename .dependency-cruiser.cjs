"use strict"
/**
 * Package-level architecture rules for the monorepo.
 *
 * `bun run arch:check` validates the rules; `bun run arch:edges` prints the
 * cross-package edge table that docs/architecture/monorepo-dependency-analysis.md
 * is built from.
 *
 * `enhancedResolveOptions` is load-bearing. Workspace packages import each
 * other as `@opencode-ai/<pkg>`, resolved through each package.json `exports`
 * map. Without `exportsFields`, every such import is unresolved and silently
 * dropped, which makes the monorepo look as if it has 2
 * cross-package edges when it has 36, and makes every rule below pass
 * vacuously. `arch:edges` fails if any `@opencode-ai/*` import is unresolved.
 *
 * @type {import('dependency-cruiser').IConfiguration}
 */
module.exports = {
  forbidden: [
    {
      name: "foundation-not-on-surface",
      comment: "Foundation packages must not depend on surface packages (apps, CLIs, the opencode entry point).",
      from: { path: "^packages/(core|effect-[^/]+|protocol|identity|llm|function|schema|httpapi-codegen)/" },
      to: { path: "^packages/(app|console|cli|desktop|containers|opencode|web|enterprise)/" },
      severity: "error",
    },
  ],
  options: {
    doNotFollow: { path: ["node_modules"] },
    // Scope to packages/*/src with `exclude`, not `includeOnly`: includeOnly
    // also drops unresolved imports, which hides the very failure the
    // `arch:edges` guard exists to catch.
    exclude: { path: "(^|/)(build|dist)(/|$)|\\.d\\.ts$|^node_modules/|^packages/[^/]+/(?!src(/|$))" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["bun", "import", "browser", "default", "types"],
      extensions: [".ts", ".tsx", ".js", ".mjs", ".json"],
    },
    reporterOptions: {
      archi: { collapsePattern: "^packages/[^/]+" },
    },
  },
}
