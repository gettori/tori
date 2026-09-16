---
summary: zshenv sets ZDOTDIR so zsh reads the rc file under that directory not home, editing the unsourced file has no effect
status: current
updated: 2026-06-28
source: Sway build plan (personal/sway); Phase 0 PATH debugging; `~/.dotfiles/zsh/.zshenv`
---

# The real .zshrc is under ZDOTDIR

Do NOT edit `~/.zshrc` to fix shell PATH on this machine; it is never sourced. Why: `~/.zshenv` sets `ZDOTDIR="$HOME/.config/zsh"`, so zsh reads `$ZDOTDIR/.zshrc` (a dotfiles symlink). PATH exports belong in `~/.zshenv` alongside the existing volta/local-bin blocks. Both `~/.zshenv` and `~/.zshrc` are symlinks into `~/.dotfiles`, so edit the resolved target.
