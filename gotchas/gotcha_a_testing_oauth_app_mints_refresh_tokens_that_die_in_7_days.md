---
summary: an OAuth consent screen left in Testing issues refresh tokens that expire in 7 days; go to production before minting the CI token
status: needs-verification
updated: 2026-10-20
source: "Browser: store release and onboarding, gettori/tickets#89 (branch `browser-extension`, commits 5fd3c397, e22ab1de); `.github/scripts/extension-upload.sh`; `docs/RELEASING.md` Secrets"
---

# A Testing OAuth app mints refresh tokens that die in 7 days

Don't mint the Chrome Web Store refresh token for CI while the Google OAuth consent screen is in Testing. Why: Google expires refresh tokens issued to a Testing app after 7 days, and Google's own Web Store API guide sets you up as a Test user, so following it gives a token that works on day one and fails the first release a week later with `invalid_grant`, in a job nothing waits on. Move the app to **In production** first, then mint the token. A token minted while in Testing keeps its short life.

Production needs the branding page complete: a homepage on a domain verified in Search Console for the project owner, and live privacy policy and terms links. That is what [[lesson_store_review_needs_its_legal_pages_live_before_the_merge]] ran into.

The 7 day figure is from Google's OAuth behaviour as remembered, not a page read during the ticket; check it if the upload starts failing.

Related: [[component_release_pipeline]].
