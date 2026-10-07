<!-- Keep the sections; delete the guidance comments. This template is for
     changes to src-tauri/agents/*.toml, dev/fixtures/ and docs/ADAPTERS.md.
     Anything else uses the default template. -->

## Adapter

<!-- Which adapter, and whether this is a repair or a new one. -->

## Measured against

<!-- The exact output of `<cli> --version` on the machine you captured on, and
     the `verified_against` value after this change. Measured means you ran
     the CLI and captured what it did; a value copied from its docs is not. -->

## What the fixture captured

<!-- Which files under dev/fixtures/ changed, what each one is a capture of,
     and which dev/ probe produced it (dev/protocol-probe.mjs, dev/acp-probe.mjs,
     a PTY capture, ...). -->

## What behaves differently

<!-- What Tori does with this agent after the change that it did not before. -->

## Checks

- [ ] `cargo test --manifest-path src-tauri/Cargo.toml emit_bundled_adapters_for_the_typescript_fallback`
      run and `dev/fixtures/agents/bundled.json` committed
- [ ] `pnpm test` passes, including `FALLBACK_ADAPTERS agrees with the bundled adapters`
- [ ] `scripts/check.sh all` passes
- [ ] Every commit is signed off (`git commit -s`)
- [ ] A guard test edited here says who measured the claim, and against which version

## Notes

<!-- Anything you decided against, anything you could not verify. Saying
     "I could not test X" is more useful than leaving it implied. -->
