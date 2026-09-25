---
summary: closing a revoked device by hub tag misses a connection authed but not yet registered; tag, then recheck the file
status: current
updated: 2026-09-26
source: gettori/tori#214 pairing plan on branch orchestrator, found by an adversary pass on the draft; src-tauri/src/rpc/server.rs (`handle`, test `a_device_revoked_while_its_auth_is_answered_is_not_served`)
---

# A revoke between auth and registration has nothing to close

Don't revoke a device only by closing the connections tagged with its id. Why: `handle` checks the credential, writes the auth reply, and only then registers with the hub. A slow client can hold that write open for as long as it likes, so a revoke landing in that window finds nothing tagged, and the connection is then served with a principal that no longer exists. Revoke removes from `devices.json` first and closes by tag second. The connection tags itself first and checks `Credential::holds` second. Whichever order the two interleave in, one side catches it.

## Related

- [[concept_device_pairing]]: where revoke sits in the pairing flow
- [[component_remote_front]]: the hub tag and `close_device`
