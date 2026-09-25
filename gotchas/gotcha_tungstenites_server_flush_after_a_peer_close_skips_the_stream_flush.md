---
summary: after a peer close, tungstenite's server flush answers ConnectionClosed before flushing the stream, so a buffering writer loses the close reply
status: current
updated: 2026-09-26
source: gettori/tori#213 on branch orchestrator; src-tauri/src/rpc/ws.rs (the `Message::Close` arm in `WsStream::read`); tungstenite 0.30 protocol/mod.rs `_write`
---

# tungstenite's server flush after a peer close skips the stream flush

Do not count on `WebSocketContext::flush` to send the reply to a client's close when the stream underneath holds bytes until its own `flush()`; flush the stream yourself after it. Why: for a server whose peer has closed, `_write` writes the queued reply into the stream and then returns `Error::ConnectionClosed` before it calls `stream.flush()`, so a buffering writer keeps the frame and the client sees a reset (`ResetWithoutClosingHandshake`, 1006 in a browser). `ws.rs` buffers each context's writes so frames go out whole under one lock, which is exactly such a stream.

## Related

- [[component_remote_front]]: where the buffering `Out` lives
