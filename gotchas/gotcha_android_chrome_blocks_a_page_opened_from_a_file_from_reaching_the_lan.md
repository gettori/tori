---
summary: a page opened from a file or content:// on Android Chrome cannot open a ws:// to a LAN address, it fails 1006 before any frame
status: current
updated: 2026-09-26
source: gettori/tori#213 on branch orchestrator; dev/remote-probe.html; tested from a phone on the LAN, 2026-09-26
---

# Android Chrome blocks a page opened from a file from reaching the LAN

Do not test a LAN front from a copied HTML file on a phone; serve the page over `http://` from the LAN and open that. Why: Chrome on Android will not let a page opened from a file (a `content://` URL from a messenger or the file manager) connect to a local network address, and the socket fails with `connection error` then close 1006 before `onopen`, which reads exactly like a server that dropped the handshake. The same page served from the Mac over `http://` on the picked address connected at once.

## Related

- [[component_remote_front]]: whose probe page this broke
