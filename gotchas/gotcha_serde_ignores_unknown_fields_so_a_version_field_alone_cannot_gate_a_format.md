---
summary: serde silently drops unknown fields, so a formatVersion field alone cannot stop an old parser reading a new file
status: current
updated: 2026-08-14
source: Chat surface plan, phase 6 (personal/tori, branch `chat`); `src-tauri/src/chat/rules.rs`, `rules_v1_frozen.rs`, **both deleted 2026-08-14** with the rule engine; the trap is general and the code that demonstrated it is gone
---

# serde ignores unknown fields, so a version field alone cannot gate a format

Do NOT assume adding `formatVersion` to v2 protects you from a v1 parser reading a v2 file: serde drops unknown fields silently, and the old parser has no idea it should look for a version. It is worse when safety rides on a *field*, as with a rule's `kind`, since dropping it turns a `deny` into an `allow`. The fix that works retroactively is to **rename a wire key the old parser requires and cannot default** (here `toriPid` to `supervisorPid`), so the old parser fails outright. Only from that version on is a version number sufficient, and only with `deny_unknown_fields` plus a separate version probe.
