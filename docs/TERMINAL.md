# The terminal

Every shell tab runs your login shell (`$SHELL`, falling back to `/bin/zsh`)
as `-l -i`: a login, interactive shell. That is the same shell you get in a
fresh Ghostty or Terminal.app window, so it sources your profile and rc files,
owns its own PATH, and carries your prompt, aliases and plugins. Tori adds
nothing on top and strips nothing out of it.

Three variables are set so a dotfile can tell it is inside Tori:

| Variable | Value |
|---|---|
| `TERM` | `xterm-256color` |
| `TERM_PROGRAM` | `Tori` |
| `TERM_PROGRAM_VERSION` | the running Tori version |

## tmux auto-attach in your rc file

A common rc block attaches a tmux session whenever a terminal opens:

```zsh
if command -v tmux &>/dev/null && [[ -z "$TMUX" ]]; then
    tmux attach-session -t main 2>/dev/null || tmux new-session -s main
fi
```

Inside Tori that block does exactly what it says: the new shell tab attaches to
the session your other terminal already shows, so the tab mirrors that window
and the session shrinks to the smaller client. VS Code, Cursor, Zed and
JetBrains terminals all hit the same block the same way, because it is the rc
file attaching, not the editor.

The fix is the one those editors rely on too: guard the block on
`TERM_PROGRAM`.

```zsh
if command -v tmux &>/dev/null && [[ -z "$TMUX" && "$TERM_PROGRAM" != "Tori" ]]; then
    tmux attach-session -t main 2>/dev/null || tmux new-session -s main
fi
```

The bash form is the same test in `~/.bashrc`:

```bash
if command -v tmux >/dev/null 2>&1 && [ -z "$TMUX" ] && [ "$TERM_PROGRAM" != "Tori" ]; then
    tmux attach-session -t main 2>/dev/null || tmux new-session -s main
fi
```

If you already skip the attach for another editor, add Tori to the same
condition rather than writing a second block.

Tori does not work around this itself, on purpose. Pre-setting a fake `TMUX`
would fool every tmux-aware prompt and plugin in the tab, and skipping your rc
files would throw away the prompt, aliases and PATH that make the tab yours.
