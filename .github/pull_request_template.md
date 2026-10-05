<!-- Keep the sections; delete the guidance comments. -->

## What this changes

<!-- One or two sentences. What behaves differently after this than before? -->

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
