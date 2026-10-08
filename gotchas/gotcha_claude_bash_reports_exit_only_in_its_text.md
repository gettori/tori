---
summary: Claude's Bash result has no exit field; a failure leads with "Exit code N", a timeout adds "Command timed out after Ns"
status: current
updated: 2026-10-08
source: "Verification badge plan (branch `phase-1-block-1`, gettori/tickets#26), measured on claude 2.1; `src-tauri/src/verification.rs` (`exit_of`, `cut_short`, `never_ran`)"
---

# Claude's Bash reports its exit only in its text

Don't look for an exit code on a Claude tool result. Why: the transcript carries only `is_error`, which Tori turns into `ToolStatus::Error`, and the code is in the output text. A failed `Bash` starts with `Exit code N`. A timeout reads `Exit code 143` then `Command timed out after 2s` on the next line, so it looks like an ordinary failure unless the second line is checked. An interrupted call contains `[Request interrupted by user`, a rejected one starts with `The user doesn't want to proceed with this tool use`, and a background run has `run_in_background: true` in its input and returns before the command ends. An `Ok` Bash exited 0. ACP is different: `ToolSummary::Execute.exit_code` carries the number. Read the summary first and the text second.

## Related

- [[component_verification]] `exit_of`, `cut_short` and `never_ran`
