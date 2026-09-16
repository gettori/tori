---
summary: installing an agent trusts the registry, the sha256 ships beside the same URL it verifies and most entries lack one
status: current
updated: 2026-08-15
source: Make a harness installable, signed in, and discoverable (personal/sway, branch `harness-lifecycle`); Phase 5; `src-tauri/src/install.rs`, `ADAPTERS.md`; registry commit `ec4f9f7c`, measured 2026-08-14
---

# What installing from the ACP Registry costs you

Sway can download an agent from the ACP Registry's `binary` distribution. The honest headline is the one the consent dialog leads with: **installing an agent is trusting the registry.** Every control below bounds a narrower thing than people assume it does.

**The checksum ships in the same `agent.json` as the URL.** So it bounds *transport* tampering: a proxy, a hijacked CDN, a corrupted download. It proves nothing about who published the bytes, because anyone who can change the URL can change the hash printed next to it. It is a transport control wearing the costume of a provenance control.

**And over half the downloads have no checksum at all.** Measured across all 39 registry directories: 17 ship a `binary` distribution, and only **9** publish a `sha256` for darwin. That optionality is carried the whole way rather than papered over: `Build.sha256` is an `Option`, `verify_checksum` returns *whether a check happened* rather than just success, `Installed.sha256` keeps `None` on the record for the life of the install, and the consent dialog says which of the two the user is agreeing to. **A verified download and an unverifiable one must not be able to render the same sentence.**

## What each check stops, and does not

| Check | Stops | Does not stop |
| --- | --- | --- |
| https, redirect downgrade refused | a downgrade to plaintext mid-redirect | a bad archive served correctly over TLS |
| sha256, when published | a modified download | a modified registry entry |
| checksum before extraction | a corrupt archive touching disk | anything, when no checksum was published |
| containment + symlink refusal | an archive writing outside its directory | the binary doing whatever it likes once run |
| Gatekeeper consent | a silent quarantine strip | the user consenting to one |

The last row is the point of making it a choice rather than a step. Clearing `com.apple.quarantine` is what makes an unnotarized binary runnable, so it is offered with what it disables stated, only where there is a Gatekeeper to disable, only when the flag is actually present, and it is logged.

## What it deliberately does not do

**It produces no adapter.** An installed agent is a path plus a manifest; the catalog row still says untested, and reaching a session means a user writing the TOML that names the path. It is never placed on `PATH`. See [[component_acp_catalog]] for how that boundary is asserted structurally rather than by convention.

**Removal deletes only what Sway installed**, refusing a directory with no manifest, so a user-installed binary of the same name is untouched.

## Implementation notes worth keeping

- **Extraction is entry by entry, not a shell out to `bsdtar`.** The containment check and the symlink refusal are properties Sway has to be able to *assert*, and a library that unpacks for you cannot be asked about them.
- Formats are named and refused rather than sniffed: darwin ships 13 `tar.gz`, 3 `zip`, 1 `tar.bz2`, and some entries point at a bare binary with no extension at all, which is why detection refuses rather than guesses.
- `write_entry` masks the archive's mode with `0o600 | (mode & 0o100)`. It was `0o700 | ...`, which is `0o700` for every entry, so every extracted data file came out executable. A package can carry more than one executable, and only the entry point is chmod'd by name afterwards.
- The per-platform entry carries an optional `env` (`vtcode` sets `VT_ACP_ENABLED`), so the manifest carries it too. Without it, a TOML written from the manifest would launch an agent that does not speak ACP.
- Two installs of one agent at once race on the directory replace. The button is disabled per row, so the reachable case is two windows, and the outcome is a failed install rather than a corrupted one. Recorded, not fixed.
- The network test is opt-in and covers **all three** formats against real archives (~150 MB), because three decompressors are three pieces of code and an in-memory tar fixture only proves one of them.

## Related

- [[component_acp_catalog]] - the rows this installs from, and why installing changes none of their claims
- [[concept_one_directory_two_spellings]] - the containment check's own path-resolution rule
- [[gotcha_ensure_inside_returns_the_callers_unresolved_path]] - the containment primitive reused here
- [[adr_harness_breadth]] - the strategy this serves
