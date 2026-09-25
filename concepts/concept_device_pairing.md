---
summary: a device trades one live 8 char code for its credential in a pair first frame that then closes; revoke tags then rechecks
status: current
updated: 2026-09-26
source: gettori/tori#214 pairing plan on branch orchestrator; src-tauri/src/rpc/pairing.rs; src-tauri/src/rpc/auth.rs (`pair`); src-tauri/src/rpc/server.rs (`handle`); src-tauri/src/rpc/hub.rs (`close_device`)
---

# Device pairing

A phone gets onto the remote front ([[component_remote_front]]) by trading a one time code, shown on the Mac as a QR and as text, for a long lived device credential. Tori keeps only the credential's hash. Revoking a device removes it from `devices.json` and closes whatever connections it has open.

## How it works

- Settings > Remote > Pair a device calls `pairing_start`, which is refused unless the front is listening and `devices.json` is writable. It returns an `Offer`: the code as `XXXX-XXXX`, the `ws://` URL, `tori://pair?url=<ws url>&code=<code>` for the QR, and the expiry.
- `Pairing` holds at most one live code: 8 Crockford base32 chars from `/dev/urandom`. A new `start` kills the old code. The code expires after 5 minutes, dies on first use, and is burned by the 5th wrong try. Stopping or rebinding the listener cancels it. Typed input ignores case, dashes and spaces, and reads I and L as 1 and O as 0.
- The device opens a connection and sends `pair {code, name}` as its first frame instead of `auth`. `redeem` runs `Devices::mint` under the pairing lock and consumes the code only if the mint succeeds, so a failed save leaves the code usable. The reply is `{id, name, credential}`, then the connection closes. The device reconnects with `auth` and the credential. The unix socket answers `pair` with "not an auth frame".
- `Pairing` reports `used`, `burned` or `cancelled` through an `on_change` closure built in `rpc::start`, which emits `remote://devices` so the pane can close the QR and say why. `device_revoke` emits the same event with `ended: null`.
- Revoke writes the file first, then `Hub::close_device`. On the connection side, `handle` tags the connection with its device id, then checks `Credential::holds`. See [[gotcha_a_revoke_between_auth_and_registration_has_nothing_to_close]].

## Why it is this way

- **One short secret, capped, instead of a long one.** The QR and the typed code carry the same key, so it has to be typeable. 40 bits is plenty with one live code, 5 minutes and 5 tries in total, on a LAN or a tailnet. 6 digits would be too few bits even with the cap.
- **Pairing closes the connection.** Continuing as the device would save one round trip, but it would add a second way into an authenticated connection. Closing keeps the one rule that every served connection starts with a credential, and the reconnect proves the client stored it.
- **The device names itself.** The Mac shows the QR with no step before it. There's no rename.
- **The QR is rendered in Rust.** The URI is already built there, so the webview sets an SVG and never builds the URI itself.
- **`tori://pair` is the contract with the mobile app (#215)**, which registers the scheme. A plain http page can't use a camera, so the probe takes the link pasted in.

## Related

- [[component_remote_front]]: the front this pairs onto
- [[adr_one_protocol_several_fronts]]: why the change stayed inside `auth.rs`
- [[gotcha_a_revoke_between_auth_and_registration_has_nothing_to_close]]: the race revoke has to close
