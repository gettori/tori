# Tori push relay

A Cloudflare Worker that holds Tori's FCM credential, so no Mac has to. It
stores nothing and cannot read what it forwards.

## Routes

`POST /register {token}` returns `{handle}`. The phone sends its FCM token and
gets it back sealed (AES-GCM) under a key only the relay has. The phone hands
the handle to its Mac; the Mac never sees the raw token.

`POST /send {handle, data, tag, ttl, priority}` returns 204. The Mac sends the
handle and `data`, a payload it encrypted with a key shared only with the phone.
The relay opens the handle and posts a data-only FCM message: `data` as `p`,
`tag` as the collapse key, `ttl` in seconds (at most a day), `priority` either
`high` or `normal`.

| Status | Meaning |
| --- | --- |
| 400 | malformed body, or a handle this relay did not seal |
| 410 | FCM says the app is gone: drop the handle |
| 413 | body over 4 KB or `data` over 1 KB |
| 429 | rate limited, per handle or per IP |
| 502 | FCM refused for another reason |

## What it sees

The Mac's IP address, when a push happens, the size of the ciphertext, and the
sealed handle. Never the project, the kind, the session or any path.

## Running it

`pnpm --dir relay dev` serves it locally, reading secrets from `relay/.dev.vars`
(gitignored):

```
HANDLE_KEY=<32 random bytes, base64>
FCM_SERVICE_ACCOUNT='<the service account JSON on one line>'
```

Production is `relay.gettori.app`. `.github/workflows/relay.yml` deploys it when
`relay/` changes on main, after approval on the `relay` environment. The
production secrets are set once with `wrangler secret put HANDLE_KEY` and
`wrangler secret put FCM_SERVICE_ACCOUNT`. Rotating `HANDLE_KEY` invalidates
every handle already handed out.
