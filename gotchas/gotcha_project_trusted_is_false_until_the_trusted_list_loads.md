---
summary: projectTrusted and projectUntrusted both read false until the trusted list loads; ask trustedNow before revoking anything
status: current
updated: 2026-11-07
source: "fit any base folder plan (branch move-any-folder-or-project-to-space), self-review S1; src/utils/projectTrust.ts; commit 48f942eb"
---

# projectTrusted is false until the trusted list loads

`projectTrusted(path)` and `projectUntrusted(path)` in `src/utils/projectTrust.ts` read one shared signal that is `null` until `trusted_projects` answers. Both return false while it is null, so "not known trusted" is not "untrusted".

**Symptom.** Code that grants trust when `projectTrusted` is false and revokes "its" grant later can revoke trust the user gave long ago: `trust_project` on a covered path is a no-op that still returns the scope.

**Fix.** For a decision that undoes a grant, read the store now with `trustedNow(path)`. The sync pair is fine for marks and early hints, where a wrong answer only delays something.

## Related

- [[adr_moving_trusts_only_with_convert]] where it bit
