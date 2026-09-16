---
summary: Kobalte's Dialog.Content never sets aria-modal, it expresses modality by hiding other elements, so wrap it in yourself
status: current
updated: 2026-08-12
source: "plan \"Dialog primitive on Kobalte with stories and behavior tests\" (personal/sway, branch `98-dialog-primitive`, issue #98); `@kobalte/core@0.13.13 dist/chunk/V25KEN4T.jsx:177-196`, `src/components/Dialog/Dialog.tsx:91`"
---

# Kobalte's dialog never sets `aria-modal`

Do NOT assume `Dialog.Content` gives you `aria-modal="true"`; it renders `role="dialog"`, `tabIndex={-1}`, `aria-labelledby` and `aria-describedby`, and nothing else. Why: Kobalte expresses modality the Radix way, by aria-hiding every other element (`createHideOutside`), so the attribute is redundant to *it* even though the app's own tests and reviewers look for it. A wrapper that promises the attribute has to pass it through itself. See [[component_dialog]].
