---
summary: the claude CLI exits 0 on an unknown flag, so acceptance proves nothing, only a validated rejection names real flags
status: current
updated: 2026-08-21
source: plan "The composer offers every lever the agent published" (phase 2, personal/tori, branch `unified-chat`), `src-tauri/src/chat/claude.rs` (`THINKING_MODES`), commit 7b9522b, [[lesson_probe_the_capability_before_building_its_control]], _2026-08-21_
---

# claude ignores an unknown flag, so acceptance is not evidence a flag exists

Do NOT conclude a `claude` flag is real because the CLI took it. Why: measured on 2.1.238, `claude --definitely-not-a-flag xyz --version` exits 0 and prints the version, so an invented flag is indistinguishable from a supported one by exit code alone. What *is* evidence is a **validated rejection**: `--thinking bogus --version` answers `option '--thinking <mode>' argument 'bogus' is invalid. Allowed choices are enabled, adaptive, disabled.` and exits 1, which is the CLI naming its own vocabulary. That is how an undocumented `--thinking` was found in the first place, and it is the same observable `dev/effort-probe.mjs` rests on for `--effort ultracode`. The inverse trap is already recorded: `--permission-mode auto` on a model without `supportsAutoMode` exits 0 and silently runs `default`.
