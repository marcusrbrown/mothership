# v0.1 release checklist

Burn-down list for shipping Mothership v0.1. Check items off as they are verified against the implemented workflow and a live draft/published release, not just against code review.

## Sidecar packaging (R2, R4)

- [ ] `bun run sidecar:build` produces `aarch64-apple-darwin` and `x86_64-apple-darwin` compiled sidecar binaries.
- [ ] Production Tauri build resolves the bundled sidecar from the app bundle/resource path; dev mode still falls back to source-tree Bun launch.
- [ ] Signed app bundle contains the target sidecar binary for each built macOS lane.
- [ ] Sidecar exits cleanly on parent-process death (no orphaned loopback listener after a force-killed app).

## Content Security Policy (R5)

- [ ] Production `app.security.csp` is a non-null object with `default-src 'self'`, `script-src 'self'`, `form-action 'none'`, `base-uri 'self'`, `object-src 'none'`.
- [ ] `connect-src` allows exact Tauri IPC origins and literal loopback (`127.0.0.1`/`::1`) only — no production `localhost`, no wildcard hosts, no scheme-less origins.
- [ ] Dev config allows Vite dev/HMR origins without leaking into the production config.
- [ ] `vite.config.ts` does not expose `TAURI_*` env vars to the frontend bundle.
- [ ] `bun run ui:build` produces a bundle that runs correctly under the configured CSP with no console CSP violations.

## Versioning (R1, R7)

- [ ] Changesets configured for a private app (no npm publish); `bun changeset` opens changesets, `.github/workflows/version.yml` opens/updates the Version Packages PR.
- [ ] `scripts/sync-version.ts` converges `package.json`, `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml` to the same semver, both during the version workflow and as a release preflight check.
- [ ] Version PR merge leaves no pending `.changeset/*.md` files.

## Release-critical repo settings (R3, R7)

- [ ] `.github/rulesets/v0-1-release-tags.json` protects `v*.*.*` tags with required status checks.
- [ ] `release` GitHub Actions environment exists with required reviewers configured.
- [ ] `scripts/apply-release-settings.ts` / `scripts/verify-release-settings.ts` round-trip cleanly against the live repo.
- [ ] `.github/CODEOWNERS` covers release workflows, Tauri release config, entitlements, and release-critical scripts.

## Release pipeline (R2, R3, R7)

- [ ] `policy-guard` rejects any trigger that is not a protected version tag push or maintainer `workflow_dispatch`, before any environment or secret is touched.
- [ ] `required-check-preflight` blocks the pipeline if release-critical repo settings are missing or the tag SHA's combined CI status is not `success`.
- [ ] Unsigned build job produces both release lanes with zero signing/updater secrets in scope.
- [ ] Sign-and-notarize job requires `release` environment approval, signs app and sidecar with separate entitlements files, notarizes and staples successfully, and cleans up the ephemeral keychain on both success and failure.
- [ ] Attest job produces GitHub artifact attestations for every DMG, updater archive, and signature with least-privilege `id-token`/`attestations` permissions only.
- [ ] Draft release contains all expected assets and a validated candidate updater manifest (`latest.json.candidate`), without exposing `latest.json` in the public feed.
- [ ] Promote job re-verifies checksums and attestations before attaching `latest.json` to the still-draft release.
- [ ] Manual publish (`gh release edit --draft=false`) is the only step that makes the release and its updater manifest public.

## Updater metadata, checksums, and provenance (R2, R7)

- [ ] `scripts/validate-updater-manifest.ts` rejects non-macOS platform entries, missing signature/URL, invalid version, downgrade metadata, and checksum mismatches.
- [ ] `SHA256SUMS` is generated only from already-signed/attested artifacts, and its digest is re-verified immediately before manifest promotion.
- [ ] Updater private key never leaves the `release`-environment-gated signing job; only the public key is committed.

## Binary entitlements (R2)

- [ ] `src-tauri/entitlements.allowlist.md` documents every entitlement in both `.plist` files with rationale.
- [ ] Main app entitlements do not include `disable-library-validation` or App Sandbox.
- [ ] Sidecar entitlements include the JIT/library-validation/network exceptions the compiled Bun binary needs, and these are not copied into the main app's entitlements.
- [ ] Signed app launches and the sidecar passes its health probe on both release lanes.

## Runbook, custody, and rollback (R3, R7)

- [ ] `docs/release/v0-1-release-runbook.md` reflects the actual implemented release sequence end to end.
- [ ] `docs/release/signing-key-custody.md` reflects the actual secret inventory, key generation/backup, and compromise/loss transition procedure.
- [ ] `docs/release/v0-1-rollback-procedure.md` reflects the actual draft-deletion and forward-patch-release response.
- [ ] `docs/release/v0-1-post-release-smoke-checklist.md` has been run end to end against a real published release with recorded evidence.
- [ ] No telemetry is present anywhere in the shipped app; the running app makes no unintended network calls beyond loopback.
- [ ] Previous-version update-path smoke is explicitly deferred until an RC/v0.1.1 update-check flow exists, not silently skipped.

## Final sign-off

- [ ] A maintainer has followed the runbook from a clean `main` branch to a draft signed release, verified it, published it, and completed post-release smoke with concrete evidence (screenshots, command output, or attached logs) attached to the release or an internal record.
