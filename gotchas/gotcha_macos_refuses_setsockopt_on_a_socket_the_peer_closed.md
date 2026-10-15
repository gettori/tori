---
summary: macOS fails setsockopt with EINVAL on a unix socket the peer closed, which hides the error reply sent just before
status: current
updated: 2026-10-15
source: gettori/tickets#24 phase tori-attach, commit 244f5b94; src-tauri/src/rpc/window.rs:527 (open_attach)
---

# macOS refuses setsockopt on a socket the peer closed

**On macOS, `setsockopt` on a unix socket whose peer has already closed fails with EINVAL ("Invalid argument").** Linux allows it. Any `set_read_timeout` after the peer hung up is a `setsockopt`.

`open_attach` read the daemon's one-line reply, cleared the read timeout for the byte stream, then checked the reply. A refused attach ("no terminal tab or terminal session X") closes the connection right after replying, so the timeout call failed first and the user saw "Invalid argument" instead of the reason. Check the reply's error before touching the socket again; only a successful reply leaves a live peer to configure.

## Related

- [[component_tori_daemon]]: the attach handshake
