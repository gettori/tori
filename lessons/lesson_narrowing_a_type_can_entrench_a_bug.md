---
summary: narrowing a type to what ships today makes today's workaround the only behavior the compiler will permit
status: current
updated: 2026-07-31
source: Session navigation moves to a History dropdown; pi and opencode are removed (branch `navigation`, phase 8, self-review); `src/utils/agents.ts` `AgentId`, `agentIdForProgram`; commit e6d98c2
---

# Narrowing a type can entrench the bug it inherits

## What happened

Phase 8's task read: *narrow every `"pi" | "claude"` union to a single-agent type.* Taken literally that is `type AgentId = "claude"`, and it type-checks. Applying it forced eight call sites to hardcode `"claude"` where the session's own `meta.agent` was already in hand — and that id is what selects an adapter's parser kind and pgrep pattern on the Rust side. A user-added adapter would have been probed with claude's pattern, never reported as running, and had its transcript read by the wrong parser. Self-review caught it; nothing else would have, because it compiles cleanly and every test passes.

## Why

The old code was `meta.agent === "pi" ? "pi" : "claude"`, which already collapsed every non-pi adapter to claude. So the bug pre-existed. What narrowing the type did was make it **unfixable without changing the type back**: with a closed literal union, passing the real adapter id is a type error, so the wrong behaviour becomes the only behaviour the compiler permits.

That is the general shape. A type narrowed to match *what ships today* freezes today's assumptions into the signature. It is safe when the set really is closed (a parser kind, a wire transport — both genuinely closed enums here). It is a trap when the set is open by design, and the registry is explicitly open: the plan's own decisions said "the registry mechanism survives" and "adding an adapter is a file drop".

## What to do next time

**Before narrowing a type to the values that ship, ask whether the set is closed by construction or merely small today.** A parser kind is closed — a TOML naming an unimplemented one must be rejected. An adapter id is not: a user drops a TOML and invents one. Model the first as an enum and the second as an open alias, and say which in the doc comment so the next narrowing pass does not have to re-derive it.

**Treat "hardcode the only current value" as a smell when the real value is in scope.** If `meta.agent` is right there, passing `"claude"` instead is discarding evidence to satisfy a type.

## Related

- [[component_agent_adapter_registry]] — the open set, and `agentIdForProgram`
- [[concept_capability_resolution]] — what an adapter id selects downstream
- [[lesson_split_identity_from_consumed_name]] — the neighbouring distinction between an id and the thing it names
