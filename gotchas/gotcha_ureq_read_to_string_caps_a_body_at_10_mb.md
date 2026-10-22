---
summary: ureq 3's read_to_string refuses a body over 10 MB, which an Actions job log passes; UreqTransport sets with_config().limit()
status: current
updated: 2026-10-22
source: gettori/tickets#45 on branch fix-ci-until-green, commit bb56adef; src-tauri/src/forge/http.rs (UreqTransport, MAX_BODY_BYTES); ureq 3.4.2 src/body/mod.rs (MAX_BODY_SIZE)
---

# ureq's read_to_string caps a body at 10 MB

Don't read a response with `resp.body_mut().read_to_string()` when it can be large. ureq 3 limits `read_to_string`, `read_to_vec` and `read_json` to 10 MB by default, and past that it fails with an error, which `UreqTransport` turns into `ForgeError::Transport`, so the caller sees a network failure rather than a big body. A GitHub Actions job log runs past it. `UreqTransport::send` reads through `body_mut().with_config().limit(MAX_BODY_BYTES)` (64 MB) for every request, since the transport is one method by design and other answers are small.

## Related

- [[component_fix_loop]]: the log read that hit it
