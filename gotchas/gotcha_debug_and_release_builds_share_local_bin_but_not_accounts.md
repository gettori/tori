---
summary: a debug build keeps tori-dev/accounts.json but shares ~/.local/bin, so a reconcile ignoring the build deletes release scripts
status: current
updated: 2026-10-08
source: "plan \"Shell command per Claude account\" (personal/tori, branch `phase-1-block-1`); `src-tauri/src/owned_state.rs:26` (`config_dir`), `src-tauri/src/account_commands.rs` (`build_tag`, `sync_in`)"
---

# Debug and release builds share ~/.local/bin but not accounts.json

Do not treat a Tori-written file outside Tori's own config dir as stale just because the current store does not mention it. Why: `owned_state::config_dir` gives a debug build `~/.config/tori-dev`, so its `accounts.json` knows none of the release build's profiles, while `~/.local/bin` (and any other home-level path) is shared. A reconcile that judged by the store alone would delete the release build's scripts on every dev launch, and the release build would recreate them on its next one. Put the build in the marker (`tori` or `tori-dev`) and reconcile only your own.

## Related

- [[component_account_commands]] - where the marker carries the build
