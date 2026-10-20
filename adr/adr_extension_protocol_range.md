---
summary: host reads MIN_PROTOCOL..=PROTOCOL both ways, and the floor rises only once the store version is public, never by release count
status: current
updated: 2026-10-20
source: "Browser: store release and onboarding, gettori/tickets#89 planning and two adversary passes (branch `browser-extension`, commit 24465fe8); `src-tauri/src/browser_host.rs` (`mismatch`, `MIN_PROTOCOL`); `extension/src/tab.ts` (`PROTOCOL`); `docs/RELEASING.md` Browser extension protocol"
---

# The extension and the host check a protocol range, gated on the store

**Every frame from the extension carries a `protocol` integer, and the native host reads a range, `MIN_PROTOCOL..=PROTOCOL`.** Below it the host answers "update the Tori extension", above it "update Tori", and a frame with no number counts as 0. The integer moves only on a breaking change to the frame. `MIN_PROTOCOL` rises only once the store version that speaks the new protocol is public.

## Why

The two halves update on different clocks. The store updates the extension within hours of a version being published, but every version first waits for a store review of unknown length, and Tori updates when the user updates it. Any rule that ties them to the release number breaks for days at a time.

## Considered Options

- **Exact app version match.** Simplest, but every release would refuse every installed extension until the store review of the new version passed.
- **A single integer, checked one way.** The ticket's first idea. A breaking bump would strand every installed extension in the same review window, and an extension newer than the installed Tori would fail with whatever error the call produced.
- **A single integer, both ways.** Clear messages, same outage on a bump.
- **Negotiation** (the extension also speaks a range and the host picks). Rejected as more code for a window the maintainer controls, since the maintainer decides when the store version goes live.

## Consequences

- A breaking change keeps the old frame shape in the host for as long as the old extension can still be installed, which is until the new store version is public. With daily releases that is several releases, not one, which is why the rule names the store and not a count.
- A user on an old Tori after a protocol bump gets "update Tori" and cannot use the extension until they update; accepted.
- `MIN_TORI`, the oldest Tori the extension claims to work with, moves when the extension's own `PROTOCOL` rises above what an older Tori's host reads, not with `MIN_PROTOCOL`.
- The refusal is reported to the daemon so Settings names the side to update; a call that gets past `permit` clears it, because reaching the daemon proves the protocol matched.

Related: [[component_browser_extension]], [[component_release_pipeline]].
