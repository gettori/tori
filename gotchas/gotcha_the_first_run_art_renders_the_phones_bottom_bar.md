---
summary: first-run intro renders the phone's Root and BottomBar: a new prop fails only root tsc, a new client method throws
status: current
updated: 2026-10-31
source: "Review inbox plan (branch `phase-1-block-2`, gettori/tickets#32); commits fb28a0fb, 6fe8ba85, d95439d9; release-per-component phase phone-protocol (`noClient` in `src/panels/FirstRun/intro/art/Mobile.tsx`); `mobile/src/BottomBar.tsx`, `mobile/src/Root.tsx`"
---

# The first-run art renders the phone's bottom bar

Do NOT trust a clean `tsc` inside `mobile/`, or a green test run, after changing a phone component. `src/panels/FirstRun/intro/art/Mobile.tsx` mounts `mobile/src/BottomBar.tsx` and `Root` with stub props and a fake client cast `as unknown as RemoteClient`. A missing prop shows only in the root `tsc`, which the pre-push hook runs. A new `RemoteClient` method that `Root` calls passes every `tsc` and throws when the intro renders, and no test renders it. Run both `tsc`s, and add the stub to the intro's props and to `noClient`.

## Related

- [[component_review_inbox]] where the Inbox props first tripped it
- [[component_remote_front]] the phone client whose `update` signal tripped the client half
