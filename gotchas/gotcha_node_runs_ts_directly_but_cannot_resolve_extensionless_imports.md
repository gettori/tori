---
summary: node's type stripping is not module resolution, an extensionless import inside a .ts file works under vite but not node
status: current
updated: 2026-07-24
source: "Native theming system: palette + roles generator (personal/sway, branch `terminal-editor-design`); Phases 1, 6; `scripts/check-tokens.mjs`"
---

# node runs `.ts` directly, but cannot resolve extensionless imports

Do NOT assume a `.mjs` script that imports a `.ts` file will work just because node (v22.22+) strips types natively. Type stripping is not module resolution: an extensionless `import ... from "./roles"` **inside** that `.ts` file is resolvable by Vite and vitest but not by plain node, which throws `ERR_MODULE_NOT_FOUND`. This bit `scripts/check-tokens.mjs`, which imports `roles.ts` and `schema.ts` (both fine, both imported with explicit `.ts`), and blocked a scratch script from importing `contrast.ts` (which imports `./roles` extensionless, per repo convention). Either write the extension in the imported module's own imports, or iterate through vitest instead of a standalone script.
