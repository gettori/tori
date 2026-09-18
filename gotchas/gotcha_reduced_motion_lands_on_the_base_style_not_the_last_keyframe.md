---
summary: reduced motion drops a finished animation onto its base style not its last keyframe, keep the lit state as the base
status: current
updated: 2026-07-20
source: "Status deepening: checkpoint timeline, tree revert, touched markers, live indicator (personal/tori, branch `main`); Phase 2; `src/styles/base.css:23`, `src/panels/Editor/FileTree/FileTree.module.css`, `src/panels/Editor/{Editor,SessionPanel}.module.css`; see [[component_session_worklog]]"
---

# Reduced motion lands on the base style, not the last keyframe

Do NOT put the dimmed half of a pulse on the element's own class and let the keyframes only brighten it. Why: `src/styles/base.css` handles `prefers-reduced-motion` globally by setting `animation-duration: 0.01ms` **and** `animation-iteration-count: 1`. With the default `animation-fill-mode: none`, a finished animation drops the element back onto its **base style** — not onto the 100% keyframe, which is the intuitive but wrong mental model. So `opacity: 0.3` on `.editingDot` itself would leave every reduced-motion user with a permanently invisible indicator, while looking perfect for everyone else. The invariant: the **base style must be the lit steady state**, and all dimming must live **only inside the keyframes**. The three live-editing pulses (FileTree row dot, editor tab dot, Session panel label) each carry a comment saying so, because the failure is invisible in review and invisible to anyone not testing with reduced motion on. Related: a vitest guard for this was attempted and abandoned — see the CSS-imports gotcha above; `scripts/check-tokens.mjs` is the right home if it is ever worth pinning.
