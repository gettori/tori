---
summary: counts every raw occurrence of a rule and lets only a named entry with a reason and exact count through, else it fails
status: current
updated: 2026-08-15
source: "plan \"Tooltip primitive and the `title=` sweep\" (personal/sway, branch `102-tooltip-primitive`, issue #102); `src/test/interactiveTitle.test.ts`, `scripts/check-tokens.mjs`, `src/lib/boundary.test.ts`; commits c996ca9, dbfa12a"
---

# The named-exemption guard

Sway's repeated shape for a repo-wide rule: **count every occurrence, and exempt only by a named entry carrying a stated reason and an exact count.** The guard classifies nothing itself. Anything it has never heard of lands in the failure list rather than slipping past, which is what "fails open" means here. `check-tokens.mjs` established it for colour literals; `interactiveTitle.test.ts` is the fullest expression of it.

## How it works

Three properties, all load-bearing:

- **Scan for the raw thing, not for the violation.** `interactiveTitle.test.ts` matches `/\btitle=/` across every `.tsx` under `src/`. It does not ask which tag it is on. A `title=` on a component invented tomorrow changes a count, and the count is what fails.
- **Exact counts, not "at most".** A file that *gains* an occurrence fails even though it is already exempt, and a file that loses its last one fails until its entry goes. Neither list can rot into a blanket pardon.
- **Every exemption states a reason, in prose, in the file.** Shared reasons are named constants (`TRUNCATION`, `HEADING`, `ROW_ONCLICK`, `FIXTURE`), so two files claiming the same exemption visibly claim the *same* one, and changing the rule changes it once.

The guard also asserts its own reach — that the glob matched more than 100 files, that it contains `App.tsx`, that more than 50 files hold a match — because a scan that quietly matches nothing passes every assertion downstream ([[lesson_a_rule_that_matches_nothing_passes_every_guard]]).

**Reading tags needs a real parser, and the naive version is quietly wrong.** Scanning backwards from an attribute to the nearest `<` reads `<IconButton icon={<Icon …/>} title=…>` as a tag called `Icon`, so every icon button in the app misclassifies. `tagRegions()` forward-scans each opening tag to the `>` that closes it, tracking brace depth, quotes **and comments** ([[gotcha_an_apostrophe_in_a_jsx_tag_comment_runs_a_naive_attribute_scanner_to_eof]]). `regionAt()` returns the *innermost* enclosing region, not the first: an attribute's tag region runs to its closing `>`, so a `<Tab>` nested in an `<OverflowTabBar>`'s `renderTab={…}` would otherwise report the tab bar's attributes.

**It counts prose, deliberately.** A `title=` inside a doc comment is counted like any other, which is why `Tooltip.tsx` describes the attribute rather than writing it. Teaching the scan to skip comments means deciding what a comment is inside JSX text — a `//` in a URL in JSX children would eat the rest of the line — and a blind spot bought that way is worth less than the occasional reworded sentence.

## Why it's this way

The inverse guard — "fail when `title=` appears on a button-ish tag" — is the one that must not be written. It passes vacuously the moment somebody adds a component that forwards `title` to a button, because the new component's name is not in its list and nothing says so. That mistake was made once while measuring #102: a first pass classified by tag and missed `Tab`'s three sites, because `Tab` extends `ButtonHTMLAttributes` and forwards `title` to the DOM without the word "button" appearing at any call site.

**Its limit is classification, not coverage**, and that limit is real: five entries sat under plausible wrong reasons for three phases and passed every count. See [[lesson_a_named_exemption_can_be_wrong_and_still_pass]] — the counterpart lesson, and the reason a ledger like this needs a read-through at close, not only a green run.

Where a type can carry the rule instead, it should: #102 ended by making `title` a type error on all four tooltip-bearing components, leaving the guard responsible only for what the type cannot see (a native title on a raw element). A guard is the backstop for the sites a type cannot reach, not a substitute for reaching them.

## Where it is used

- `src/test/interactiveTitle.test.ts` — every `title=`, plus assertions that the 64 kept ones stay on `span`/`div`/`code` (asserted as a per-tag breakdown, not a total, so a `span` becoming a `button` fails even if the sum is unchanged), that none appears on a natively interactive tag, and that the ten clickable-`div` rows stay ten.
- `scripts/check-tokens.mjs` — colour literals outside `tokens.css`, with an allow-list of files and one directory. Gates `pnpm test`. Note it reads a three-digit `#102` as a hex colour ([[concept_design_token_system]]).
- `src/lib/boundary.test.ts` — a plain text scan for `@kobalte/core` outside `src/lib/` ([[component_lib_boundary]]). Being a text scan, it fails on its own doc comment naming the package, the same prose sensitivity as above.
- `src/test/menuIdioms.test.ts` — the two test idioms #103's migration had to sweep: a `fireEvent.click` on a line naming a menu role, and a `fireEvent.mouseDown` with no `pointerDown` beside it ([[gotcha_a_kobalte_menu_answers_no_plain_click]]). Two exemptions, each with a reason. Its own twist on the shape: a third test fails if an exemption outlives the occurrence it exempts, which is this ledger's version of "exact counts". It also excludes itself from its own glob, since a source-scanning test reads its own regexes ([[gotcha_a_source_scanning_test_in_the_file_it_scans_reads_itself]]).

## Related

- [[lesson_a_named_exemption_can_be_wrong_and_still_pass]] — the failure mode this shape does *not* catch
- [[lesson_a_rule_that_matches_nothing_passes_every_guard]] — why the scan asserts its own reach
- [[lesson_a_gate_that_cannot_fail_is_not_a_gate]] — the sibling failure, an assertion that cannot go red
- [[concept_tooltip_trigger_is_the_control]] — the rule this guard enforces
- [[concept_design_token_system]] — `check-tokens.mjs`, where the shape started
- [[component_lib_boundary]] — the third instance
- [[gotcha_a_source_scanning_test_in_the_file_it_scans_reads_itself]]
- [[gotcha_an_apostrophe_in_a_jsx_tag_comment_runs_a_naive_attribute_scanner_to_eof]]
