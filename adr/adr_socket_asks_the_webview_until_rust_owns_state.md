---
summary: socket actions go to the webview as request/reply and session state is pushed into Rust, so #212 swaps the backend without a wire change
status: current
updated: 2026-09-23
source: gettori/tori#198 on branch orchestrator; commits 15f6b615 (state push), 9c01ba2a (bridge), 85430c9e (asks); src-tauri/src/rpc/{states,bridge,asks}.rs; src/utils/rpcBridge.ts
---

# The socket asks the webview until Rust owns the state

**What only the webview knows today reaches the socket two ways: session state is pushed into a Rust cache, and actions (spawn, open, quota, ask cards) go to the webview as a request with a reply.** Spawning, the status dot, the concurrent cap, quota readings and question cards all live in the Solid side, and the socket ([[component_app_socket]]) has to answer for them before #212 moves them into Rust.

## Considered Options

- **Move spawn and status into Rust now** (rejected): that is #212 pulled forward, and it would have held up every CLI command behind a rewrite of the chat panel's ownership.
- **Request/reply for state too** (rejected): `sessions.list` and the `sessions` topic are the most frequent calls, and each would pay a webview round trip, fail when the window is reloading, and turn a hidden window's throttling into CLI latency.
- **Push state, ask for actions** (chosen): state is small and changes on turn boundaries, so the webview sends the whole list whenever it moves. Actions are rare and need the webview anyway.

## Consequences

- **The wire does not change when #212 lands.** A bridged method is one `Backend` implementation; when Rust owns spawn, that method stops going through `Bridge` and callers never notice. The phone front (#213) inherits the same methods.
- **A bridged call can fail for a reason a Rust one cannot**: no window answering. It times out after 10 s with an error naming the window rather than hanging the caller.
- **Anything that must survive a reload lives in Rust, not in the webview store.** Asks and their answers are the case: the webview pulls open asks back on start and hands answers to Rust at once.
- **State is only as fresh as the last push.** A session the webview has not reported yet is live with no state; the webview sends the whole list rather than deltas so a reload cannot leave a stale entry behind.

## Related

- [[adr_one_protocol_several_fronts]] - the protocol this answers on
- [[component_app_socket]] - `SessionStates`, `Bridge` and `Asks`
- [[component_tori_cli]] - the front that exercises every bridged method
