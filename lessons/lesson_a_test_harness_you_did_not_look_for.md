---
summary: absence of test files is not absence of a harness, read the runner config before concluding a capability is missing
status: current
updated: 2026-08-01
source: "Search panel v2: toggles, ignored files, replace-in-files (personal/sway, branch `wave-1-2`); Phases 1 and 2; `vitest.config.ts`; PR #81; issue #11"
---

# Read the config before concluding a capability is missing

## What happened

Planning the search panel, I checked whether component tests were possible here by listing test files: `src/**/*.test.ts` turned up only pure helper tests, so I concluded vitest reached utilities only. That went into the plan's Context, into a self-review finding, into the phase notes, and into the PR description. Five UI tasks were written with `verify (manual)` on the strength of it.

`vitest.config.ts` defines **two** projects. The second is a jsdom project over `src/**/*.test.tsx` with `@solidjs/testing-library` and a shared `domSetup.ts`, and ten Chat panel tests had been using it for months. The extension I globbed for was the one thing that could not match a component test.

Rewriting those five verifies as real tests took under an hour and immediately caught a bug the manual checks would have described but not proven: closing and reopening the replace row left the preview absent until the replacement was retyped.

## Why

Absence of callers is not absence of capability, and the two look identical from a file listing. A harness is defined by configuration, not by usage: the config is what makes a capability exist, while the files are only evidence that someone has used it. Searching for the second and concluding about the first is a category error, and it is self-confirming in the worst way, because a project with a harness nobody has used yet looks exactly like a project with no harness.

It compounded because the wrong conclusion made the work look harder than it was. Once "no component harness" was written down, marking UI verifies manual was the reasonable move, and a manual verify is one nobody can fail. Three artifacts then repeated the claim, so the error propagated faster than it could be noticed.

## What to do next time

Before recording that a capability is unavailable, read the file that would enable it, not the files that would use it. For test harnesses that means the runner config; for a build feature, the build config; for a dependency, the manifest and the installed package.

Two supporting habits. State the check that produced the conclusion, not just the conclusion, so "no `*.test.tsx` files exist" stays visibly different from "component tests are impossible", and the gap between them is where the mistake lives. And treat `verify (manual)` as a claim needing its own justification: it should mean *this genuinely requires a human*, as with the cross-component reload smoke that closed this ticket, never *I could not find a way to automate it*.

## Related

- [[lesson_grep_the_installed_dep_before_wiring_a_binding]] - the same error about a dependency's contents rather than a runner's config
- [[lesson_prove_flag_parity_by_running_the_tools]] - the same ticket, the same shape: check the thing itself rather than reasoning about it
- [[gotcha_vite_plugin_solid_forces_a_jsdom_test_environment]] - the config split that makes both projects necessary
- [[component_search_panel]] - the component whose tests this unblocked
