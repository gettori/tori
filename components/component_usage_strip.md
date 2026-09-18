---
summary: UsageStrip draws one cluster per account not per chat; UsageCard shows every window Tori read, even ones the chips hide
status: current
updated: 2026-09-06
source: "Agent usage preview plan (personal/tori, branch `agent-usage`), phase 2, rebuilt to the design after phase 5 . PR #169"
---

# Usage strip and its card (the titlebar quota preview)

**Location:** `src/components/UsageStrip/` (key files: `UsageStrip.tsx`, `UsageStrip.module.css`, `UsageCard.tsx`, `UsageCard.module.css`)

The titlebar's quota preview: a row per account with a reading, sitting bare on the topbar between the toolbar and the update pill, and a card that opens under the pointer to explain it. The strip is scanned, the card is read. Neither writes a setting.

## Responsibilities

- Draw one cluster per **account**, never per chat, and only for accounts whose chips light something.
- Open the card on hover after a delay, keep it on a click, and survive a reading landing while it is pinned.
- Ask for a fresh read on hover (throttled downstream) and on the card's refresh button.
- **Not** settings. The chips, the warn point and the notify switch are on the account's settings card; a surface that opens under a passing pointer must not carry a control you can change on the way past.
- **Not** history, and not a breakdown link. `UsageCard.test.tsx` pins the absence with the argument so it cannot drift back in.

## What it draws

**The strip.** Monospaced, no surface of its own. One glyph per agent on its leading account, and no agent name beside it: the mark is the name, and spelled out it was the widest thing on the strip saying the least. The leading login is drawn in full, a short label, a 24x4 track and the level at one decimal per window; every other login of that agent is its own name and one figure, the window it is nearest to (`tightestWindow`, `UsageStrip.tsx:59`). A thin rule divides two logins, a taller and stronger one divides two agents. Colour is the band ladder, and never `--blocking-*` (see the gotcha below).

**The card.** Header of glyph, agent name and a freshness stamp that ticks every second while the card is open, with a refresh button where a read path exists. Then an account row: the logins as tabs when there are two or more, the email when there is one, then the plan and model count. Then a row per window with its full name, level, reset (a countdown inside a day, a weekday past one) and a full-width bar. Then a boxed sentence about where this is heading, which names the **other** login when that is the one in trouble, because that is the case a strip glance misses.

**The card shows every window Tori has read, whatever the chips say.** The chips decide what the titlebar carries and only that; hiding a bar is not the same as not wanting to know (`readWindows`, `UsageCard.tsx:119`).

## Key files and entry points

- `UsageStrip.tsx:95` - `clusters()`, which builds the rows: chips gate presence, sorting is agent-major then default-first, and the first row of each agent is the `lead` one.
- `UsageStrip.tsx:59` - `tightestWindow`, ranked by state before level, so a window that has already reset never wins over a live one.
- `UsageStrip.tsx:168` - `UsageBar`, and its `compact` mode for a second login.
- `UsageCard.tsx:133` - `paceSentence`, and `otherAccountClause` at :165.
- `UsageCard.tsx:119` - `readWindows`, the deliberate divergence from the strip's filter.

## Two structural rules that are load bearing

- **`Index`, not `For`.** `clusters()` builds fresh objects on every run and `<For>` is keyed by reference, so a reading landing on any turn boundary replaced the very button a pinned card was anchored to, leaving the popover hanging off a removed node. Position is the right key here: rows come and go with accounts, not with readings. See [[gotcha_reordering_a_referentially_keyed_for_must_preserve_object_identity]].
- **No `title=` on the bars.** They sit inside the cluster's `<button>`, so a native `title` would be mouse-only text on an interactive control. The per-window summary is in the cluster's `aria-label`, where a keyboard user gets it too. See [[gotcha_every_title_in_src_is_counted_dialog_title_props_included]].

## Connections

- Depends on [[component_usage_pipeline]] - reads the store and calls the poll; holds no readings of its own.
- Depends on [[component_popover]] - the card is a `Popover`, controlled and mounted-is-open, rather than a new HoverCard primitive; the hover timing belongs to the strip because only it knows where the pointer is.
- Governed by [[concept_design_token_system]] - and by check 10 in particular, see below.
- Sibling of [[component_agent_health_cards]] - which owns every control this surface deliberately does not.

## Related

- [[concept_quota_is_an_account_fact]] - the model it draws
- [[gotcha_check_10_only_scans_the_chat_panels_stylesheet]] - why the strip wears attention and danger and never the blocking tier
- [[concept_ui_scaling_system]] - every size here is a token or a `calc(px * var(--ui-scale))`
