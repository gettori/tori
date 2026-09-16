---
summary: SSH_ASKPASS only fires with no controlling terminal and REQUIRE force set, and never answers an unknown host key prompt
status: current
updated: 2026-07-10
source: Askpass credential bridge for backgrounded git (personal/sway, branch code-mirror-6); `src-tauri/src/git.rs` (`git_command`); commit 3fff674
---

# SSH_ASKPASS needs REQUIRE=force and only fires without a TTY

`GIT_ASKPASS` is called directly by git and is reliable for HTTPS, but `SSH_ASKPASS` is conditional: ssh uses it **only when there is no controlling terminal** AND `SSH_ASKPASS_REQUIRE=force` is set (OpenSSH >= 8.4) - merely exporting `SSH_ASKPASS` is not enough. Separately, a first connection to a host absent from `known_hosts` raises `Are you sure you want to continue connecting?`, which askpass does **not** answer; a no-TTY ssh then aborts with `Host key verification failed`. Handle it with `GIT_SSH_COMMAND="ssh -o StrictHostKeyChecking=accept-new"` (TOFU: auto-add an unknown host, still reject a *changed* key) rather than assuming SSH "just works."
