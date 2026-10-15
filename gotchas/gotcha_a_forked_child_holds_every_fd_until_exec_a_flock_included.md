---
summary: a child forked anywhere in the process inherits every open fd until it execs, so a released flock can still look held
status: current
updated: 2026-10-15
source: gettori/tickets#24 phases state-in-daemon, bridge-into-rust and remote-in-daemon; src-tauri/src/rpc/daemon.rs:1068 (started); src-tauri/src/exec.rs:141 (repo_lock)
---

# A forked child holds every fd until exec, a flock included

**`flock` belongs to the open file description, and a `fork` duplicates every fd, so the lock stays held while any child forked in that window has not yet called `exec`.** Rust opens files with `O_CLOEXEC`, which closes them at `exec`, not at `fork`. Between the two, the child holds the lock.

Seen three ways in #24:

- The daemon tests started a daemon right after another test's daemon stopped and found `daemon.lock` still held by a probe the Composer had forked (about 1 run in 8). `started()` now retries for 2 s.
- `the_repo_lock_shuts_out_another_opener` saw `tori.lock` held by a git child another test forked.
- The real app waits for the old daemon's lock to be released before spawning the next one, or the new one exits as already running. A production `tori daemon` start can still meet the same window.

When a test asserts a lock is free, wait for it with a deadline rather than checking once.

## Related

- [[component_tori_daemon]]: the pidfile lock
- [[gotcha_rust_tests_sharing_a_temp_path_keyed_only_on_process_id_race_each_other]]: the other cross-test race in this suite
