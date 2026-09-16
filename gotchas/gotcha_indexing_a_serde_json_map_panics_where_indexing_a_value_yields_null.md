---
summary: indexing a serde_json Value answers a missing key with null but indexing the inner Map panics, keep the read on Value
status: current
updated: 2026-08-17
source: plan "Model catalogues from the harnesses themselves" (phase 1, personal/sway, branch `settings-and-chat`); `src-tauri/src/chat/claude.rs::absorb_control_response`; commit "Read an account that left a field out"
---

# Indexing a `serde_json::Map` panics where indexing a `Value` yields null

Do NOT reach through the inner `Map` when reading an optional key out of parsed JSON. `Value`'s `Index` impl answers a missing key with `Value::Null`, which is why `v["account"]["organization"].as_str().unwrap_or_default()` is the idiomatic tolerant read; `Map`'s impl **panics**. `claude.rs::absorb_control_response` had bound the account object as a `Map` and then indexed it, on a code path whose own doc comment promised the opposite ("a plan with no organization is still a known account"), so the one shape the branch existed to tolerate killed the reader thread instead. Real claude always sends all three keys, so nothing on any machine hit it: only a fixture written to exercise the tolerant path found it. Read through `Value` and let null be null, and treat "this branch has never executed against the real binary" as a reason to write the fixture, not a reason to trust it.
