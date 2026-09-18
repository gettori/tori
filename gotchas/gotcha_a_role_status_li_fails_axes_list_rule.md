---
summary: an ARIA role on a list item replaces its implicit listitem role and axe fails the parent list for it
status: current
updated: 2026-08-15
source: "plan \"Toasts onto Kobalte Toast\" (personal/tori, branch `105-toasts`, issue #105); `src/components/Toasts/Toasts.tsx`; see [[component_toasts]]"
---

# A `role="status"` `li` fails axe's list rule

Giving a list item an ARIA role replaces its implicit `listitem` role, and axe then fails the parent for holding something that is not a listitem ("`<ul>` and `<ol>` must only directly contain `<li>`"). Kobalte's toast `List`/`Root` default to `ol`/`li` and its `Root` sets `role="status"`, so the default markup cannot pass the a11y gate: render both with `as="div"`. A stack of independently-announced status regions is not a list in any meaningful sense anyway.
