---
summary: a store field whose only writer is the confirmation path cannot also hold a provisional guess without outranking it
status: current
updated: 2026-09-04
source: plan "Seed a chat's mode and model from the pick that spawned it" (personal/sway, branch `bugfix-260903`, issue 163), `src/panels/Chat/chatStore.ts` (`openingModel`, `seedModel`, `noteModel`), [[component_chat_model_resolver]], _2026-09-04_
---

# A store field with one writer cannot double as a provisional value

Do NOT park a "probably right, nothing confirmed it" value in a field whose only writer is the confirmation path. `chatStore.ts`'s `modelValue` has exactly one write site, inside `noteModel`, and it fires only when a pending pick's resolved id matches what init reported; `beginReconnect` does not clear it either. So seeding it from the tab's opening pick (the obvious fix, and what issue 163 implies) would have made the seed outrank `state.model` for the life of the tab, because `selectedModel` prefers `picked` before it ever looks at the resolved id. Any model change that did not go through Sway's own picker (`/model` in the composer, a PTY tab on the same session) would then be masked permanently rather than for one turn. Give the provisional value its own field (`openingModel`) and rank it in the resolver instead. The tell is a seed that the correction path has no reason to touch. Note the asymmetry: `noteMode` writes `s.permissionMode` unconditionally, so seeding *that* is safe and self-correcting.
