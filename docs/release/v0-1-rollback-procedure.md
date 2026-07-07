# v0.1 rollback procedure

Mothership never rewrites public release history. Once a release is published (draft status removed), it stays published; rollback means containing the damage and shipping a corrected release, not deleting or force-changing what's already public. This document covers the two phases where a release can go wrong: before publish (still a draft) and after publish (already public).

## Rollback triggers

Treat any of the following as a rollback trigger:

- Clean-machine install/launch fails on either release lane (Gatekeeper warning, crash on launch, sidecar fails its health probe).
- Updater manifest validation fails (`scripts/validate-updater-manifest.ts` rejects the manifest for any reason: missing signature/URL, non-macOS platform entry, downgrade relative to the previous release, checksum mismatch).
- Checksum or provenance verification fails (`SHA256SUMS` does not match a downloaded artifact, or `gh attestation verify` fails for any artifact).
- CSP behavior check shows unexpected remote content, broadened script-src, or any non-loopback network call from a normally-running app.
- A security issue is discovered in the published artifacts (dependency vulnerability, signing/entitlement mistake, leaked credential) after publish.
- The release workflow itself fails partway through signing/notarization/publish, leaving inconsistent or partial artifacts.

## Response while still a draft (before publish)

This is the cheap path — nothing public has changed yet.

1. Do not run the manual publish command. A draft release is invisible to `/releases/latest` and to users.
2. If the draft's artifacts are wrong (bad signature, wrong version, failed manifest validation), delete the draft release: `gh release delete vX.Y.Z --repo marcusrbrown/mothership --yes`. This also deletes its uploaded assets.
3. Delete the associated git tag if it needs to be reissued: `git push --delete origin vX.Y.Z` (and locally: `git tag -d vX.Y.Z`). Because the tag ruleset restricts who can create/force-push `v*.*.*` tags, only the same reviewer who can approve releases can do this.
4. Fix the underlying issue (code, config, or workflow), land it on `main` through normal PR review, and restart the release sequence from a fresh version tag. Do not reuse the same tag name for a materially different build.
5. Leaving a broken draft release around is not itself a public risk — `latest.json` is never promoted to a draft's stable feed asset until the manual publish step — but delete it anyway to avoid confusing future release attempts or reviewers.

## Response after publish (already public)

Once `gh release edit vX.Y.Z --draft=false` has run, the release is public and its `latest.json` (if that release is the newest non-draft, non-prerelease release) is part of the live updater feed. Do not delete or retag a published release, and do not force-push over the git tag.

1. **Prevent further `latest.json` promotion if the issue is caught before promotion runs again.** If the flaw is in a release still mid-pipeline (draft exists, promotion hasn't happened yet), stop before running `promote-updater-manifest` and follow the draft-phase procedure above instead.
2. **If the public release's `latest.json` is already live and wrong or unsafe:** do not edit or delete the published release's assets in place — that would silently rewrite what existing installs may have already fetched or verified. Instead:
   - Publish a new patch release (`vX.Y.Z+1`) through the full normal release sequence, with the fix included, as fast as the pipeline allows.
   - The new patch release's `promote-updater-manifest` step naturally becomes the newest non-draft, non-prerelease release, so its `latest.json` supersedes the broken one for any future updater check.
   - If the broken release is actively harmful to already-installed copies (e.g., crashes on launch, exposes a real security issue), mark it clearly in its GitHub release notes as broken/superseded and point users at the patch release. Do not delete it — deleting a published release can break any reference or provenance record already pointed at its assets/attestations.
3. **If the issue is a signing/updater key compromise rather than an application bug,** stop and follow `docs/release/signing-key-custody.md`'s compromise/loss procedure instead of this one — that is a credential incident, not a release-artifact rollback.
4. **If the release workflow itself failed partway through** (e.g., sign-and-notarize succeeded for one lane but not the other, or the workflow errored before `publish-draft`), no draft or public release exists yet for that run. Confirm no partial GitHub Release was created (`gh release list`), confirm the ephemeral CI keychain cleanup step ran (`if: always()` — it should have, even on failure), and simply re-run the release workflow from a fresh attempt once the underlying failure is fixed. Idempotent jobs mean a clean re-run does not require manual artifact cleanup beyond confirming no stray draft release exists.

## What "rollback" does not mean here

- It does not mean force-pushing or deleting a published git tag.
- It does not mean editing a published release's assets in place.
- It does not mean rewriting `CHANGELOG.md` history for a version that has already shipped.
- It does not mean attempting to make an already-updated install revert itself — v0.1 has no in-app rollback mechanism; the response to a bad public release is always "ship a fixed release forward," per the KTD8/updater-key-permanence decision that treats the update path as forward-only for the v0.x line.
