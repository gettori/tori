---
summary: mocking listen as one handler per event name drops a second subscriber, so the test fires into the wrong component
status: current
updated: 2026-08-01
source: "Fix the stale `fs://changed` payload contract in ReviewPanel (personal/tori, branch `wave-1-3`); `src/panels/Editor/ReviewPanel.test.tsx:49`; issue #12"
---

# A keyed listener map in a test shadows a second listener for the same event

Don't mock `listen` as `handlers[name] = fn` when the component under test renders a child that subscribes to the same event. Why: `ReviewPanel` renders `CheckpointTimeline` unconditionally and both take `fs://changed`, so a one-entry-per-name map keeps only whichever mounted last, and the test then fires into the wrong handler, failing against correct code or passing vacuously depending on mount order that nothing in the test pins. Production delivers to every listener, so the mock must too: `(handlers[name] ??= []).push(fn)`, then fire them all. Assert the expected listener count as part of the setup, or the tripwire quietly disappears the day the child stops listening.
