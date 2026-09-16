---
summary: a new chat tab spawns no harness until first send, beating eager spawn at open and a background spawn hybrid
status: needs-verification
updated: 2026-08-20
source: not recorded; imported from grimoire docs/personal/sway; reverses the stance of commit ddcf047
---

# New chats open as drafts: no harness process until first send, then a structural lock

A new chat tab is pure client state with no spawned harness, any chat-capable agent and model pickable from the probe cache; the first successful send mints the session id, spawns the agent lazily (Claude picks via `build_args` argv, ACP picks via `session/set_config_option` after `session/new`), and locks the tab to that agent at send-capable, after which the palette is fed a single-provider list rather than disabled rows. This reverses the `ddcf047` stance that no pick is replayed at spawn: staging a pick before a process exists is the point of the draft, while "no pick" still means no flag, so an untouched draft keeps opening on the CLI's own defaults.

## Considered Options

- Eager spawn at tab open (status quo): live catalogue before typing, but commits the harness at the moment the user has decided nothing.
- Speculative hybrid (background-spawn the default harness, kill and respawn on switch): hides ~1.6s of Claude spawn latency, rejected for lifecycle complexity (close-await races, claim churn, discarded children) that pure laziness deletes outright; revisit only on measured annoyance.

## Consequences

- First messages pay spawn plus handshake (~1.6s Claude, ~1s expected ACP), masked by a pending composer state and a Sway-owned first-send deadline.
- Drafts hold no ownership claim and every send attempt mints a fresh session id, so pre-spawn conflicts cannot exist and a failed attempt's id is dead.
- Pre-spawn pickers run entirely on the probe cache; Sway still declares no model the harness did not name.

## Related

- [[adr_harness_breadth]] - the growth axis this serves
- [[adr_native_chat_surface]] - the surface it reshapes
- [[component_chat_panel]] - where the draft state lives
- [[component_catalog_probe]] - the pre-spawn data source
- [[concept_no_turn_probe]] - why the cache exists at all
