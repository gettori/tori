---
summary: rpc/pr_rules.rs matches a watch's pending news to its project's prRules; Office::pr_rules_tick files items and hands the watch over
status: current
updated: 2026-10-22
source: gettori/tickets#44 on branch evernt-automation, plan "Event rules: queue a ship item when a watched PR needs work"; commits 5718fccb, df4d2c0a; src-tauri/src/rpc/pr_rules.rs, src-tauri/src/autopilot.rs, src-tauri/src/rpc/office.rs, src-tauri/src/settings.rs (PrRule), src/panels/ProjectSettings/AutomationsSection.tsx, src/components/Autopilot/Rules.tsx
---

# Pull request rules

`src-tauri/src/rpc/pr_rules.rs`, with the filing in `autopilot.rs` and the tick in `rpc/office.rs`: a project rule that hands a watched PR to the autopilot once its chat is gone.

## Responsibility

- **The setting.** `Settings.pr_rules` (`prRules`), a map keyed by project path to `PrRule { on: Vec<PrEvent>, max_per_hour }`, default cap 3. It lives in user settings only, read leniently through `lenient_map`. `PrEvent` is `changes_requested`, `check_failed` or `conflicting`.
- **Matching.** `hits` (pure) takes each unended watch whose project has a rule. The first pending `News` the rule names becomes a `RuleHit`, if `session_ended` says the chat is gone. A changes-requested review is a `Remark` with `review == "changes_requested"`.
- **Filing.** `plan_rule_firings` (pure) needs a contract, and skips while `rule_paused`. An open item on the PR (`pr_key`) takes the hit instead. Otherwise it writes a `Kind::Ship` item with `Source::Rule`, `pr_url` and `url` set, a title like "Changes requested on #N" and the task as its `contract`. `AutopilotStore::fire_rules` runs it under `write`.
- **The tick.** `Office::pr_rules_tick` runs on the daemon side of `pr_watch::fold`, gated on `autopilot.available`. It calls `Watch::hand_over` on every handed watch and wakes the autopilot through `watcher_picked`.
- **The pause.** `rule_paused`: `max_per_hour` firings since `resumed_at` that fit inside one hour. `rules.json` holds only `resumed`. `rule_rows` gives the Cockpit each rule with `fired_this_hour` and `paused`.

It does not poll, pick a worktree or push. The brief does those, through `worktree_new` with `pr` and `pr.push`.

## Interface

- Tauri: `autopilot_rules` and `autopilot_rule_resume {project}`, over office ops. There is no socket row, so no agent can resume a rule.
- `autopilot.changed` carries `rule_resumed`. The window store re-reads rules on it, on a rule item event, and on `settings://changed`.
- UI: **When a watched pull request needs work** in Project Settings > Automations, and **Pull request rules** in the Cockpit ([[component_autopilot_cockpit]]).

## Related

- [[adr_a_pr_rule_hands_a_watched_pr_to_the_autopilot_once_its_chat_is_gone]]: why it is shaped this way
- [[component_pr_watch]]: where the news comes from
- [[component_autopilot_store]]: the queue it files into
- [[component_autopilot_schedules]]: the sibling it copies the pause and resume from
