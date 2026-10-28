---
summary: don't record usage inside ChatHost itself, host tests would write ~/.config/tori/usage; go through set_on_turn
status: current
updated: 2026-10-28
source: gettori/tickets#48 on branch cost-per-ticket, plan "Cost per ticket and per pull request, with a projection before queueing", commits 798e6f83, a72dc201, 6374485e, e0acfc08; src-tauri/src/chat/host.rs:1003 (set_on_turn); src-tauri/src/rpc/daemon.rs:1000
---

# A ChatHost test writes the real usage dir if it records directly

Don't call `usage::record_live` from `ChatHost` or `Lifecycle` themselves. Why: `record_live` writes under the real config dir, and every host test that finishes a turn would leave usage files there; the hook (`ChatHost::set_on_turn`) is set only by the daemon, so tests record nothing unless they set one.

A host test that wants the hook to fire also needs `set_publisher` and a `cwd` on its `StartSpec`, since the folder is read off the announced place.

## Related

- [[concept_spend_attribution]]: where the hook is set
