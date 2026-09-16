---
summary: Rust's DefaultHasher suits a within run cache key and is catastrophic in a persisted ref name since std never fixes it
status: current
updated: 2026-08-05
source: "Editor Wave 6: the IDE surface (personal/sway, branch `wave-6`); Phase 15, issue #51, commit b622f33; `src-tauri/src/local_history.rs:71`"
---

# Never build a persisted key out of a hash whose algorithm is unspecified

## What happened

Local history names its refs with two digests: one of the worktree toplevel, one of the repo-relative path. The first cut reached for `std::collections::hash_map::DefaultHasher`, because `search.rs` already uses it and it is right there. Self-review caught it: std explicitly declines to guarantee the algorithm across releases.

## Why

The consequence is not a wrong answer, it is a silent and total loss. After a toolchain upgrade, every existing ref would hash to a name nothing computes any more. Reads would return an empty timeline, which reads exactly like "this file has no history yet". Worse, the worktree sweep collects any key not among the live worktrees' hashes, so the orphaned refs would then be *deleted* on the next prune. Nothing anywhere would report an error.

The distinction that matters is what the hash is *for*. `search.rs`'s use is legitimate: a within-run cache key, recomputed and consumed inside one process, where a changed algorithm changes nothing. A digest that names a ref, a file, a directory, a database row or a cache entry on disk is a different kind of thing. It is part of the data format.

## What to do next time

- **Ask whether the hash outlives the process.** If it does, it is format, and it needs an algorithm you have written down.
- **Spell the algorithm out.** FNV-1a is eleven lines and has no dependency; `local_history.rs:71` is the reference implementation in this repo. Copy it rather than reaching for a crate for a non-cryptographic digest.
- **The same applies to any language's "default" hasher**, and to anything documented as "may change between releases". Rust is unusually honest about it; other runtimes are not, which makes the trap quieter there.
- **Check the failure direction.** This one failed toward silent deletion, which is why it earned a fix rather than a note. A digest whose drift merely causes a cache miss is a different risk.

## Related

- [[concept_local_history_blobs]] — the ref layout the digest names.
- [[lesson_checkpoint_refs_keyed_by_timestamp]] — the neighbouring lesson about what a ref name may safely encode.
- [[gotcha_a_repo_relative_path_is_not_a_legal_ref_path]] — why a digest was needed at all.
