---
summary: a signed out CLI reports the full published surface as a capability, so measure entitlements only after signing in
status: current
updated: 2026-08-14
source: "\"Defer permissions to the harness, and grow to four harnesses\" (phase 8, branch `chat-fix`); `dev/codex-probe.mjs`; measured against `codex-cli` 0.147.0 and `@agentclientprotocol/codex-acp` 1.2.0"
---

# Sign in before measuring a capability, or you measure somebody else's

## What happened

Phase 8 had to choose between shipping Codex as a four-line TOML over its first-party ACP wrapper, or building a second typed transport against the native `codex app-server` protocol. The strongest argument for the native path was its model catalogue: `model/list` returned **7 models** against the wrapper's 4. A 43% shortfall in the picker is exactly the kind of thing that justifies several sessions of work.

The machine was not signed in to Codex. Signed in, both return the same **4**.

The phase's own opening note said to sign in before deciding. It was right for a reason nobody had written down.

## Why

A signed-out CLI answers a capability query from whatever it knows statically: the full published surface, an unfiltered default, a hardcoded list. A signed-in one answers from the account: the providers that user has authenticated, the models that subscription reaches, the entitlements they actually have. Those are two different questions and only one of them is about the user.

The direction of the error is what makes it dangerous. Signed out, a probe reports the **superset**, so a capability looks *better* than it is, and the tool that reports it looks better than its rival. The same shape had already been seen and named one phase earlier without being generalised: OpenCode's ACP model catalogue is per account, listing only the providers that account has authenticated, which is why a bundled `[[chat.models]]` table would be a guess about somebody else's account.

## What to do next time

- **Authenticate before probing anything that could be entitlement-shaped**: model lists, quotas, feature flags, available providers, plan tiers. Signing in is minutes; the wrong architecture decision is weeks.
- **When two paths are being compared, measure both on the same turn, in the same account state.** The 7-versus-4 number was not wrong as a measurement. It was wrong as a *comparison*, because the two sides were probed under different conditions.
- **Write the account state next to the figure**, the way `verified_against` records a version. A capability count with no account state beside it is not reproducible and should not decide anything.
- **Distrust a probe that flatters the option you have not built yet.** That is the direction the signed-out error points, and it points there for free.

## Related

- [[component_acp_transport]] — the transport the wrapper feeds, and the work this measurement decided against duplicating
- [[adr_harness_breadth]] — where the typed-adapter-per-vendor option is weighed
- [[concept_acp_config_options]] — where a per-account model catalogue arrives from
- [[lesson_debug_the_harness_before_recording_the_outcome]] — the sibling failure: a probe that lies because of how it was run
- [[lesson_probe_the_capability_before_building_its_control]] — probe first, but probe as the user
