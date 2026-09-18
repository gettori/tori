---
summary: merges three usage sources into one account keyed store, gating which reads may spawn a process, token stays in memory
status: current
updated: 2026-09-06
source: "Agent usage preview plan (personal/tori, branch `agent-usage`), phases 1 to 5 . PR #169"
---

# Usage pipeline (sources, store, notification)

**Location:** `src/utils/usageStore.ts`, `src/utils/usageProbe.ts`, `src/utils/usagePoll.ts`, `src/utils/usageNotify.ts`, `src/utils/chatRateLimit.ts`, `src-tauri/src/usage_token.rs`, `src-tauri/src/usage_probe.rs`, `src-tauri/src/usage_snapshot.rs`

Everything between "some source said a number" and "a bar changes colour". Three sources write into one account-keyed store, a scheduler decides when the two that spawn a process may run, a snapshot file carries the store across a relaunch, and one effect turns a crossing into an OS notification. The surfaces read the store and nothing else, so a bar cannot tell which rung filled it.

## Responsibilities

- Merge readings per (agent, account) and per window kind, forward only ([[concept_quota_is_an_account_fact]]).
- Decide when a read may spawn a process, and refuse otherwise.
- Keep the account token out of everything it writes: read into memory for one request, never logged, never on disk.
- Announce a crossing once per window per reset, and never while Tori has focus.
- **Not** history. There is no ring and no chart; see [[lesson_history_of_what_you_only_sometimes_watch]].
- **Not** provenance on screen. The store records each reading's source and sample time, and the card shows one freshness stamp built from them rather than a rung and a clock per row.

## Key files and entry points

- `src/utils/chatRateLimit.ts:101` - `quotaState`, and `quotaBand` at :133, `limitTypeLabel` at :187, `paceOutAt` at :285. Pure, and the one place a window has a name.
- `src/utils/usageStore.ts:117` - `recordReadings`, the merge. `temporalOf` at :161. The account key's NUL separator at :58.
- `src/panels/Chat/ChatView.tsx` - the free rung: a `rateLimit` event files under the session's **resolved** profile, so a resumed chat lands on the login its transcript is actually in.
- `src-tauri/src/usage_probe.rs:289` - `usage_probe_codex`, one `codex app-server` exchange for windows and identity together, since Codex's `login status` names nobody. Windows are mapped by `windowDurationMins`, never by slot order.
- `src-tauri/src/usage_token.rs:208` - `read_usage`, whose first statement is the gate (:216). `service_for` at :32 derives Claude's per-home Keychain service name; `Anthropic::get` converts the endpoint's 0-to-100 utilization and its ISO reset string once, named.
- `src/utils/usagePoll.ts:58` - `mayPoll`, pure. `MANUAL_GAP_MS` at :34, `backoffUntil` at :87.
- `src/utils/usageProbe.ts:169` - `pollUsage`, which spawns. Per-account clocks at :90, the per-agent queue at :97, the sweep at :189.
- `src/utils/usageNotify.ts:46` - `collectQuotaNotifications`, pure; `watchQuotaNotifications` at :86.
- `src-tauri/src/usage_snapshot.rs:65` - `UsageSnapshot`, one file under Application Support, debounced 5s.

## How the scheduler behaves

The split is deliberate and follows [[concept_forge_rate_budget]]'s shape: `usagePoll.ts` decides and `usageProbe.ts` acts. The cost being managed is a process and a second or two of someone else's CPU, so the rules are about restraint rather than a budget. Nothing runs while the window is hidden. The background tick needs a chat of that agent open to be worth anything. Focus and hover share a 30s floor because both arrive in storms.

The floor is **per account** and the queue is **per agent**. Keying both to the agent starved every login but the first, which is [[lesson_a_floor_above_the_unit_starves_all_but_the_first]]. What the per-agent queue still buys is that two Claude logins are read one after the other rather than raising two Keychain dialogs in the same breath.

`manual` (a switch just turned on, or the card's refresh button) skips the floor and outranks a backoff, because a press refused for a timer has nothing to show for itself and the answer is what says why. It carries two guards of its own instead: a 10s gap, and a drop if a read for that account is already in flight. Without them a pressed button asked the endpoint three times back to back and was answered 429.

## Connections

- Depends on [[component_agent_adapter_registry]] - the `[usage]` table declares which rungs an adapter has a read path for, and `PROBE_COMMAND` in `usageProbe.ts` is the frontend half of the same list.
- Governed by [[adr_usage_source_ladder]] - where readings may come from, and the one Keychain exception.
- Governed by [[adr_credential_custody]] - which this amends by exactly one file name.
- Used by [[component_usage_strip]] - the titlebar strip and its card.
- Used by [[component_agent_health_cards]] - the account card's quota half.

## Related

- [[concept_quota_is_an_account_fact]] - the model the store implements
- [[concept_transport_neutral_event_model]] - `ChatEvent::RateLimit` and its generated-fixture guard
- [[lesson_synthetic_test_values_hide_unit_bugs]] - why the endpoint's two unit conversions are pinned against captured magnitudes
- [[gotcha_a_trigger_that_skips_the_poll_floor_needs_its_own_guard]] - the 429
- [[gotcha_an_unsigned_rebuild_prompts_again_for_the_same_keychain_item]] - what the opt-in copy has to promise
