# v0.1 release runbook

This is the operational procedure for shipping a signed, notarized macOS release of Mothership. It assumes `docs/release/signing-key-custody.md` credential preflight has already passed. See `docs/release/v0-1-rollback-procedure.md` for what to do if a release needs to be aborted, and `docs/release/v0-1-post-release-smoke-checklist.md` for what to verify immediately after publishing.

## Release environment setup

- GitHub Actions environment named `release` must exist with required reviewers configured (currently `@marcusrbrown`), and must hold the secrets listed in `docs/release/signing-key-custody.md`.
- `.github/rulesets/v0-1-release-tags.json` protects `v*.*.*` tags: only the repository owner/admins can create or force-push them, and required status checks must be green at the tag SHA before the release workflow's required-check preflight will proceed.
- `.github/CODEOWNERS` requires owner review on the release workflow, version workflow, CI workflow, release-critical scripts, Tauri release config, and entitlements files — no automation bypasses this.
- Release settings are automated, not runbook-only assumptions: `scripts/apply-release-settings.ts` applies the ruleset/environment configuration, and `scripts/verify-release-settings.ts` re-verifies it as the first gated step in `.github/workflows/release.yml` before any secret-bearing job runs.

## Automated release settings

Run once per repo (or after any settings drift):

```sh
bun scripts/apply-release-settings.ts --repo marcusrbrown/mothership --reviewer marcusrbrown
bun scripts/verify-release-settings.ts --repo marcusrbrown/mothership
```

`--reviewer` takes a **GitHub user login** (e.g. `marcusrbrown`), not a team slug — the `release` environment's required-reviewer configuration only accepts individual user or team reviewers, and this project's release trust boundary requires a specific accountable person, not a team. Pass it once per additional reviewer if more than one is ever configured.

The release workflow re-runs the verifier automatically on every run; a settings regression fails the release before it reaches signing, not after.

## Required reviewers

- The `release` GitHub Actions environment requires explicit approval from the configured reviewer(s) before the sign-and-notarize, publish-draft, and promote-updater-manifest jobs can execute. This is the human gate that keeps signing/updater secrets out of PR- and fork-triggered runs.
- CODEOWNERS requires the same reviewer's approval on any PR that touches the release trust boundary (workflows, scripts, Tauri config, entitlements).
- Reviewer values throughout release tooling (`--reviewer` above, CODEOWNERS entries, environment settings) are always individual GitHub user logins, never team names — the release environment models "who can approve this specific run," which this project treats as a single accountable owner (currently `@marcusrbrown`), not a rotating team.

## Release sequence

1. **Changeset lands.** Every user-visible PR includes a changeset (`bun changeset`) describing the change and bump type, unless deliberately waived.
2. **Version PR.** `.github/workflows/version.yml` opens/updates a "Version Packages" PR that bumps `package.json`, regenerates `CHANGELOG.md`, and runs `scripts/sync-version.ts` to converge `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml` to the same semver. Review and merge this PR like any other.
3. **Mainline CI green.** Confirm the merge commit passes the full `ci.yaml` suite (typecheck, test, lint, design-check, release-config smoke, workflow lint).
4. **Protected version tag.** Create and push `vX.Y.Z` pointing at the merged version-PR commit. The tag ruleset restricts who can create/force-push this ref.
5. **Trigger & ref guard.** The release workflow's `policy-guard` job runs `scripts/release-policy.ts` to confirm the trigger event/ref shape is an eligible protected tag push or maintainer `workflow_dispatch` — before any environment or secret is touched.
6. **Required-check & settings preflight.** `verify-release-settings.ts` confirms the ruleset/environment configuration is actually in place, and a separate step confirms the tag SHA's combined commit status is `success`. Either failure blocks the run before signing.
7. **Unsigned build.** Two matrix jobs (`aarch64-apple-darwin`, `x86_64-apple-darwin`) build the sidecar and the unsigned app bundle with no signing/updater secrets in scope.
8. **Release environment approval.** The reviewer approves the `release` environment for this run, unlocking the sign-and-notarize job.
9. **Sign, notarize, staple.** For each release lane: import the Apple certificate into an ephemeral keychain, `codesign` the app bundle and sidecar separately (see entitlements below), notarize and staple with `notarytool`, package the DMG, create and sign the updater archive with the Tauri updater private key, then delete the ephemeral keychain (`if: always()`, runs on both success and failure).
10. **Attest provenance.** A separate, minimally-privileged job (`id-token: write`, `attestations: write`, no signing secrets) generates native GitHub artifact attestations for every DMG, updater archive, and signature file.
11. **Draft release.** `publish-draft` generates `SHA256SUMS` and its digest from the already-signed/attested artifacts, generates a candidate updater manifest (`latest.json.candidate`, deliberately not `latest.json`), validates it with `scripts/validate-updater-manifest.ts` against the previously published version, and creates a **draft** GitHub Release containing the DMGs, updater archives/signatures, checksums, and the candidate manifest.
12. **Draft-to-publish checks.** Perform the manual verification below before doing anything else.
13. **Promote updater manifest.** Once verification passes, `promote-updater-manifest` re-verifies the checksum digest and artifact attestations, re-validates the manifest, and attaches it to the draft release as `latest.json`. This is still attached to a **draft** release — it does not enter the public `/releases/latest` feed until the draft is published.
14. **Publish.** A maintainer manually publishes the draft release via the GitHub UI or `gh release edit <tag> --draft=false`. This is a deliberate manual action, not part of the automated workflow, so a human always makes the final "this is live" decision.
15. **Post-release smoke.** Follow `docs/release/v0-1-post-release-smoke-checklist.md`.

## Toolchain and provenance

Release builds pin the following toolchain surfaces so a release can be rebuilt and audited without "latest" drift:

- **Bun:** installed via `oven-sh/setup-bun` pinned to a specific commit SHA (see `.github/workflows/release.yml`); the workflow requests `bun-version: 1.3.14`; update this line whenever the pinned Bun runtime changes.
- **Rust/Tauri toolchain:** installed via `dtolnay/rust-toolchain` pinned to a specific commit SHA (no version tags exist for that action, so the SHA is the pin).
- **Third-party GitHub Actions:** every action reference in `.github/workflows/release.yml` is pinned to a full commit SHA with a version comment (e.g. `actions/checkout@<sha> # v6.0.3`), not a floating tag.
- **Release scripts:** `scripts/release-policy.ts`, `scripts/verify-release-settings.ts`, `scripts/validate-updater-manifest.ts`, and `scripts/sync-version.ts` are part of the trust boundary and require CODEOWNERS review for any change.
- **Provenance binding:** GitHub's native artifact attestations (`actions/attest-build-provenance`) bind each signed DMG/updater archive/signature to the exact workflow run, commit SHA, and pinned toolchain that produced it. `SHA256SUMS` is generated only from already-attested artifacts, and its own digest is checked immediately before the manifest promotion step to catch tampering between draft creation and promotion.

## Binary entitlements

Every signed binary in the release bundle has its own entitlements file — see `src-tauri/entitlements.allowlist.md` for the authoritative table and rationale for each entry.

| Binary | Entitlements file | Notes |
|---|---|---|
| Main app / main webview | `src-tauri/Entitlements.plist` | JIT + unsigned-executable-memory for WKWebView's JavaScriptCore, plus network client for loopback bus/sidecar connections. Explicitly does **not** include library-validation disable or App Sandbox. |
| Compiled `ide-server` sidecar | `src-tauri/sidecar-Entitlements.plist` | Same JIT/unsigned-executable-memory needs (Bun's own JS engine), plus `disable-library-validation` (required for `bun build --compile` output under Hardened Runtime) and both network client/server (loopback listener). These sidecar-only exceptions must never be copied into the main app's entitlements file. |

Before freezing entitlements for a release, complete the verification checklist at the bottom of `src-tauri/entitlements.allowlist.md` (both release lanes launch and pass health checks; `codesign --display --entitlements :-` shows exactly the expected entitlements and no more).

## Draft-to-publish checks

Before publishing a draft release, verify all of the following:

- **Clean-machine install/launch, both lanes.** On a machine that has not previously trusted this app, download the arm64 DMG, install, and launch. Repeat for the x64/Rosetta DMG on either an Intel Mac or an Apple Silicon Mac running it under Rosetta. Confirm no Gatekeeper warning appears (notarization/stapling succeeded) and the app window opens.
- **Updater metadata/signature validation.** `bun scripts/validate-updater-manifest.ts --manifest latest.json.candidate --checksums SHA256SUMS` (already run in CI, but re-run locally against the downloaded draft assets as an independent check) confirms macOS-only platform entries, present signature/URL per platform, and no downgrade relative to the previously published version.
- **Checksum/provenance match.** Recompute `shasum -a 256` locally on each downloaded DMG/archive and diff against `SHA256SUMS`. Run `gh attestation verify <artifact> --repo marcusrbrown/mothership` for each DMG/archive and confirm it passes.
- **CSP behavior.** Launch the installed app and confirm the main window loads with no CSP console errors, no unexpected remote content loads, and the devtools network panel shows only loopback (`127.0.0.1`/`::1`) and `ipc:`/`http://ipc.localhost` traffic.
- **No unintended network calls.** With no user action beyond normal startup, confirm the app makes no calls to any host other than the loopback bus/sidecar. Mothership ships with no telemetry and makes no updater feed calls from inside the running app in this release; any network activity beyond loopback is a release blocker.
- **Previous-version update-path smoke — deferred.** v0.1 does not implement in-app update UX or automatic feed polling, so there is no "existing install upgrades to this version" smoke test to run yet. This is deferred until an RC or v0.1.1 path introduces a real update-check flow; until then, the manifest/signature/checksum validation above is the full extent of updater verification.

If any check fails, do not publish — follow `docs/release/v0-1-rollback-procedure.md`.

## Manual publish command reference

```sh
# Inspect the draft before publishing
gh release view vX.Y.Z --repo marcusrbrown/mothership

# Publish once all draft-to-publish checks pass
gh release edit vX.Y.Z --draft=false --repo marcusrbrown/mothership
```
