---
summary: a Volar server (Astro, Vue, MDX) throws on initialize unless typescript.tsdk is set, use the ${tsdk} placeholder
status: current
updated: 2026-10-09
source: "Support Astro plan (branch `phase-1-block-1`, gettori/tickets#70); `src-tauri/lsp/astro.toml`, `src-tauri/src/lsp.rs` (`resolve_tsdk`); @astrojs/language-server 2.17.2 `bin/nodeServer.js:14`; commit 7d4a6ee2"
---

# Volar servers refuse `initialize` without a tsdk

Do NOT ship a config for a Volar-based server (Astro, Vue, MDX) without `[initialization_options.typescript] tsdk = "${tsdk}"`. The server embeds its own TypeScript service instead of talking to tsserver, and `onInitialize` throws "The `typescript.tsdk` init option is required" when the option is missing, so the session dies before any feature runs. Don't assume the project's TypeScript will be there either: `astro` does not depend on `typescript`, so most Astro projects get Tori's bundled copy (5.9.3, shared with `typescript-language-server`). Why: the server has to be told which `typescript/lib` to `require`, and only the backend knows the root.

## Related

- [[component_lsp_host]] , how `${tsdk}` is resolved and where the path is logged
- [[lesson_the_handshake_succeeded_and_the_feature_is_silent]] , the same habit of reading the installed server before trusting a config
