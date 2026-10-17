---
summary: truncating a log a child still writes needs the child's fd in append mode, or its next write leaves a hole of zeros
status: current
updated: 2026-10-18
source: plan "Run and teardown commands beside the setup command" on branch phase-1-block-4, ticket gettori/tickets#41; src-tauri/src/setup.rs:122
---

# Cutting a log a child writes needs append mode

`trim_log` (`setup.rs:122`) keeps a run's log bounded by copying its tail, truncating the file and writing the tail back, while the child keeps writing to the same file.

A file opened with `File::create` gives the child an fd with its own offset. After the truncate, the child's next write lands at its old offset, far past the new end, and the gap reads back as zeros: the file stays as big as before, just sparse. Opening the log with `OpenOptions::new().create(true).append(true)` before handing it to the child (`stdout` and its `try_clone` for `stderr` share the description) makes every write go to the current end, so it lands after the tail that was put back.

A few lines written between the read and the truncate are lost. That is accepted for a dev server's log.

Related: [[component_run_command]]
