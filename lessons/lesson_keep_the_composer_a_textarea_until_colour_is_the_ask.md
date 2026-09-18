---
summary: split what a request wants into signal and decoration before swapping an editing surface, only the signal needed a chip
status: current
updated: 2026-09-07
source: "plan \"Chat composer Tier 1: spell check, safe sends, draft tooling\" (personal/tori, branch `composer-260907`, merged into `logo-update-260907`) . `src/panels/Chat/Composer.tsx` . commits `39a05ac`, `face7c4`, `c3eb12f`, `8e8579e`"
---

# Separate the signal from the decoration before buying a new editing surface

## What happened

The ask was to improve the chat input: a spell checker, and colour on the wrong words. A textarea cannot colour a range of its own text, so the request read as "replace the textarea", either with a mirrored overlay or with CodeMirror 6, which is already a dependency. Neither was needed. Native WebKit spell check was one attribute plus four user defaults, and the part of the colouring that carried information (a mention whose file is gone) fit on the attachment chip that was already on screen. Seven features shipped on the same textarea.

## Why

Colour on a mention does two different jobs. Confirming that `@` worked is decoration, and the chip appearing already confirms it. Saying that the file behind the mention has been deleted is information, and nothing on screen was saying it. Only the second one justified a surface change, and it did not need one.

The two rejected routes both cost more than they returned. The overlay (a mirrored div under a transparent textarea) has to keep wrapping, font fallback and scroll in step at every zoom step, and it is deleted outright if CodeMirror ever lands. CodeMirror is the real answer for in-text colour and vim keys, but it costs the lazy-boundary rule (`lazyEditorBoundary.test.ts` keeps it out of eager modules and the composer is on the startup path), it disables the macOS text system by default (`spellcheck`, autocorrect and the substitution flags are all off in its content DOM), and it rewrites most of an 800-line test file from `fireEvent` to transaction dispatch.

## What to do next time

Before replacing an input surface, split the request into what carries information and what merely confirms an action, and ask what the platform already does natively. Then keep the pieces that would survive the swap surface-agnostic: `insideFence(text, caret)`, `quoteBlock(text)` and the `ComposerHandle` interface are all pure or caret-based, so a future CodeMirror composer calls the same functions from a keymap instead of reimplementing them. The swap stays available; it is just no longer the price of admission.

## Related

- [[component_chat_panel]] - what shipped on the textarea instead
- [[concept_scratch_draft_link]] - the escape hatch for a prompt that really does want an editor
- [[gotcha_webkits_text_checking_is_a_user_default_and_a_dev_build_writes_under_the_domain_tori]] - the native spell check that made the dependency unnecessary
