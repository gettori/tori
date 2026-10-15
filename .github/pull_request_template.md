<!-- Keep the sections; delete the guidance comments.
     A new or changed pack goes to gettori/packs, not here. -->

## What this changes

<!-- One or two sentences. What behaves differently after this than before? -->

## Changelog

<!-- The bullets that go into CHANGELOG.md and the release notes, as they
     should read there: for someone using Tori, not someone reading the code.
     Name the setting or the button the way the UI does. Write `none` when
     nothing a user would notice changed (a refactor, CI, docs). The release
     script collects this section from every merged PR, so a line missing
     here is missing from the release. -->

## Why

<!-- The problem, not the patch. Link an issue if there is one. -->

## How to test

<!-- Steps someone else can follow on their own machine. Name the agent and
     the panel if the change is UI. -->

## Checks

- [ ] `scripts/check.sh all` passes
- [ ] New colors go through `src/styles/tokens.css` with a value for **both**
      themes, not through the guard's allowlist
- [ ] Checked in both light and dark, if this touches UI

## Notes

<!-- Anything you decided against, anything you could not verify, anything the
     reviewer should look at first. Saying "I could not test X" is more useful
     than leaving it implied. -->
