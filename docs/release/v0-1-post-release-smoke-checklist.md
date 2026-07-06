# v0.1 post-release smoke checklist

Run this immediately after publishing a release (`gh release edit vX.Y.Z --draft=false`). It confirms the public release is what it should be, independent of the checks already performed against the draft before publish.

- [ ] `gh release view vX.Y.Z --repo marcusrbrown/mothership` shows the release as published (not draft), with the expected tag, name, and asset list (both DMGs, both updater archives + signatures, `SHA256SUMS`, `SHA256SUMS.digest`, `latest.json`).
- [ ] `curl -fsSL https://github.com/marcusrbrown/mothership/releases/latest/download/latest.json` resolves to this release's manifest (confirms this release is now the `/releases/latest` target and the stable updater feed points at it).
- [ ] Re-download both DMGs from the now-public release URLs and re-verify their checksums against the published `SHA256SUMS`.
- [ ] Re-run `gh attestation verify <artifact> --repo marcusrbrown/mothership` against the publicly downloaded artifacts (not the CI-internal copies) to confirm the public assets match what was attested.
- [ ] Clean-machine install/launch smoke on both release lanes, using the publicly downloaded DMGs (not the CI-internal build artifacts) — confirms nothing changed between draft verification and public availability.
- [ ] Confirm the app makes no unintended network calls on normal startup: no telemetry, no calls beyond loopback (`127.0.0.1`/`::1`) to the bus/sidecar, no updater feed poll from inside the running app.
- [ ] Confirm CSP is enforced in the publicly distributed build (no console CSP violations, no unexpected remote content).
- [ ] Previous-version update-path smoke: **deferred until an RC/v0.1.1 update-check flow exists.** v0.1 has no in-app updater UX, so there is no "existing install picks up this release automatically" check to run yet — record this as expected/deferred, not skipped-by-oversight.
- [ ] File any issue discovered here against the release; if any check fails, follow `docs/release/v0-1-rollback-procedure.md`.
