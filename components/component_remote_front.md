---
summary: the WebSocket front: one picked IP, device credentials only, one socket lock for frames, Rust-owned switch
status: current
updated: 2026-09-26
source: gettori/tori#213 on branch orchestrator; commits 5ea1f124, 06a2bf55 and the Phase 3 commit; src-tauri/src/rpc/{ws,remote,devices,awake}.rs; src/panels/Settings/panes/RemotePane/RemotePane.tsx; dev/remote-probe.html
---

# Remote front (Rust + Settings)

`src-tauri/src/rpc/ws.rs` and `remote.rs` put the socket's protocol on the network for a phone: the same framing, auth step and dispatcher as the unix socket ([[component_app_socket]]), behind a switch in Settings > Remote. See [[adr_one_protocol_several_fronts]].

## Responsibility

It owns listening on one address, proving a connection is a paired device, keeping frames whole, and turning all of it on and off. It does not own pairing (the QR, the one time exchange, the device list and revoke are #214), TLS, or anything a phone needs beyond the rows open to a device.

- `ws.rs`: `WsTransport` binds a `TcpListener` on one `ip:port`, non-blocking and polled every 100 ms. A self-connect wake fails once the picked address has left the machine and would hold the port; `shutdown` drops the listener instead, so the port is free at once. At most 8 live connections (`MAX_CONNECTIONS`); past that a connection is closed at accept. The live map holds `Weak<Shared>`, deregistered by `Shared::drop` when the last handle goes, and `accept` checks `stopping` under the same lock `shutdown` closes streams under, so none survives the switch going off.
- The `Stream` adapter: one text message is one JSON-RPC line each way, with `\n` and `\r` in incoming text made spaces so a pretty-printed request stays one line. The handshake runs on the first read, so the server's own 5 s auth timeout also bounds it; a write before the upgrade fails `NotConnected`. tungstenite cannot split a socket, so each direction has its own `WebSocketContext` and its own `Out` buffer, and a buffer is written whole under one socket mutex: a pong from the reader never lands inside a reply from the writer. Message and frame caps are the socket's 256 KiB `MAX_FRAME`.
- Close frames: 1001 (going away) when the front is switched off or Tori quits, 1000 on other server closes, and the reply to a client's own close ([[gotcha_tungstenites_server_flush_after_a_peer_close_skips_the_stream_flush]]). The frame is skipped while a write to a stalled client holds the writer. Without a frame a browser reports every close as 1006.
- `remote.rs`: `Remote::apply(&settings::Remote)` binds, rebinds on a changed address or port, or stops, and answers a `Status` (`off`, `listening {url}` with the bound address, `failed {error}`). An unset, non-IP or unspecified address is refused before binding. `interfaces()` reads `getifaddrs` and `classify` offers LAN, Tailscale (100.64/10 on a `utun`) and loopback, never `0.0.0.0` or link local.
- `devices.rs`: `Devices` in `~/.config/tori/devices.json`, `0600` via `owned_state::write_private`, holding `{id, name, created_ms, hash}` with the sha256 of a 32 byte credential. A file that exists but does not parse is never written over.
- `awake.rs`: `Awake` holds an IOKit `PreventUserIdleSystemSleep` assertion while the listener is up. A closed lid on battery still sleeps.

## Interface

- `auth.rs`'s `Credential::Remote(devices)` is what the front accepts: a device credential authenticates as `Principal::Device(id)`, and the process token and child tokens are refused by construction. `CallerKind::Device` is admitted on the reads, `projects.list`, `caller`, `session.steer`, `session.interrupt`, `session.pending` and `ask.answer`, subscribes to `sessions` and `session:<id>` only, and steers as `TurnBy::Local`, as typed. `device.mint {name}` is Local only.
- Tauri commands `remote_set`, `remote_status`, `remote_interfaces`. `remote_set` is the only writer of `settings.remote` (`set_settings` carries it over from disk, like `autopilot.enabled`) and applies it; `rpc::start` applies it at launch and `RpcState::shutdown` stops it.
- `RemotePane` serialises its `remote_set` calls, reloads the store after each, and drops a change equal to what is stored ([[gotcha_a_switch_fires_onchange_when_a_reload_moves_checked]]).
- `dev/remote-probe.html` is served over `http://` from the Mac on the picked address, not opened as a file ([[gotcha_android_chrome_blocks_a_page_opened_from_a_file_from_reaching_the_lan]]). `node dev/rpc-probe.mjs --no-wait --mint <name>` mints its credential.

## Related

- [[component_app_socket]]: the server, dispatcher and table this front shares
- [[adr_one_protocol_several_fronts]]: why a phone is a front and not a surface of its own
- [[gotcha_a_frontend_settings_key_with_no_rust_field_is_dropped_on_save]]: why `remote` has a Rust field, and why an older build on the same settings.json drops it
