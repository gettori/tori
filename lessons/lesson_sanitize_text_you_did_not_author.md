---
summary: a PR review comment is the first send path text nobody here wrote, and its paste terminator can turn into live typing
status: current
updated: 2026-08-03
source: "Editor Wave 3: GitHub as a first-class surface (personal/tori, branch `wave-3`); Phase 12 self-review (Major, security); commit d0d9a3e; `src/utils/safeSend.ts:93`, `src/utils/threadAsk.ts`"
---

# Sanitize text you did not author before it reaches a terminal

## What happened

Sending a review comment to the agent that wrote the branch put text on the send path that **nobody on this machine wrote**. Every earlier composer (hunk comments, selection mentions, diagnostics, conflict asks) carried content from the local repo or the local toolchain. A review comment is written by whoever reviews the pull request, and `sanitizeForSend` collapsed newlines but did not strip control bytes.

`bracketedPaste` wraps the payload in `ESC[200~ ... ESC[201~`. A comment body containing that terminator ends the paste early, and the terminal receives everything after it as **typing** rather than as pasted text, in a session where an agent is at the prompt.

## Why

The safe-send contract was built around a different threat model: the danger was a stray newline submitting the prompt early, so the guard flattened newlines. That is the correct guard for text you wrote a moment ago in your own editor. It stops being sufficient the instant the text has an author who is not the user, and the bracketed-paste framing (added for a good reason, to keep the payload inert) is itself the thing an attacker aims at, because ending the framing early is what converts data into input.

## What to do next time

Put the guard in the **shared send path**, not in the composer that noticed the problem: `sanitizeForSend` now maps tab to space and removes the rest of C0/C1 (`\p{Cc}`), so all five composers gained it at once and any sixth gets it for free. Write the test against the unguarded build first, so it is proved to discriminate.

More generally, when adding a composer, ask who wrote the text it carries. If the answer is anyone other than the user of this machine, the framing around it is now attacker-reachable and the sanitizer, not the composer, is where that is answered.

## Related

- [[concept_safe_send]] - the path this hardened, and the five composers that share it
- [[component_pull_requests_panel]] - the surface that introduced third-party text
- [[gotcha_a_bracketed_paste_payload_must_never_contain_the_terminator]]
