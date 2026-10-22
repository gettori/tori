---
summary: GraphQL author.login for a bot has no [bot] suffix that REST adds; read __typename == "Bot" or a login filter misses it
status: current
updated: 2026-10-22
source: gettori/tickets#45 on branch fix-ci-until-green, commit 02c357b4; src-tauri/src/forge/github.rs (watched_fields, watched_from_graphql)
---

# GraphQL spells a bot's login without the [bot] suffix

Don't tell a bot comment from a person's by `login.ends_with("[bot]")` on a GraphQL read. GitHub's REST API names a GitHub App's actor `vercel[bot]`, but GraphQL's `author { login }` answers `vercel`, so a login check passes every bot as a person. Ask for `author { __typename login }` and treat `__typename == "Bot"` as the bot; the fix loop keeps the `[bot]` check too, for an answer that came another way. Why it mattered: the fix loop stops on a person's remark, and a coverage or preview bot that comments on every push would stop it after the first fix.

## Related

- [[component_pr_watch]]: where remarks carry `bot`
- [[component_fix_loop]]: the stop that reads it
