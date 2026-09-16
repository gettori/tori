---
summary: every unlayered css declaration beats every layered one regardless of specificity, a layered override never reaches it
status: current
updated: 2026-08-12
source: "plan \"Migrate the seven simple dialogs onto Dialog\" (personal/sway, branch `99-migrate-seven-dialogs`, issue #99); `src/styles/reset.css:5`, `src/components/ShortcutSheet/ShortcutSheet.module.css:17`"
---

# An unlayered CSS module beats a layered one at any specificity

Do NOT try to override a rule from an unlayered stylesheet with one written inside `@layer components`. Why: the cascade puts every unlayered declaration above every layered one before specificity is even considered, so no amount of doubling a class reaches it. `Dialog.module.css` and `Dialogs.module.css` are unlayered while `ShortcutSheet.module.css` is not, which is how a per-dialog width override can be shipped, look deliberate, and do nothing. Hoist the overriding rule out of the layer, then double the class to win the resulting same-specificity tie without depending on import order. Related to [[concept_design_token_system]]'s `@layer` order and to [[gotcha_same_specificity_hover_and_active_declare_active_last]].
