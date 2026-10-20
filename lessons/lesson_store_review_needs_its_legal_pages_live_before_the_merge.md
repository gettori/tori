---
summary: the privacy policy sat on an unreleased docs branch while the merge waited on review; branding also needed Search Console and Cloudflare DNS
status: current
updated: 2026-10-20
source: "Browser: store release and onboarding, gettori/tickets#89 (branch `browser-extension`); gettori/web#8 (`/privacy-policy`, `/terms-and-services`); `extension/store/listing.md`"
---

# A store submission needs its legal pages live before the code can merge

## What happened

The plan put the extension's privacy text on tori-web's `after-<version>` docs branch, which goes live with the release, and gated the code's merge on the store page being public. The store listing's privacy policy URL therefore pointed at a page that could only exist after a review that needed it: a deadlock, caught only while walking through the submission step by step.

Getting the CI token added a second gate. Google's OAuth consent screen will not leave Testing (see [[gotcha_a_testing_oauth_app_mints_refresh_tokens_that_die_in_7_days]]) until its branding is complete: a homepage on a domain the project owner has verified in Search Console, and privacy policy and terms links that load with real content. Neither page existed. A 404 is reported as "does not have sufficient content".

Verifying the domain had its own trap. `gettori.app` is registered at Porkbun but its nameservers are Cloudflare's, so the Search Console TXT record goes in Cloudflare; a record in Porkbun's DNS panel is never served. "Not registered to you" persisted while the existing `google-site-verification` record belonged to a different Google account than the Cloud project's owner, or while `gettori.app` was missing from the branding page's Authorized domains.

## What to do next time

- Anything a store, an app store or an OAuth screen links to (privacy policy, terms, homepage) goes on the site's `main` and is deployed before the submission, not on a docs branch that ships with the release.
- Before a multi step external process, walk it end to end on paper and ask which step needs something a later step produces.
- For domain verification, check `dig +short NS <domain>` first: the DNS host is wherever the nameservers point, not the registrar.

Related: [[component_browser_extension]], [[lesson_privacy_claims_are_assertions_about_the_binary]].
