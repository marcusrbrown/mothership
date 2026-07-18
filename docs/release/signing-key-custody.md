# Signing key custody

Mothership's v0.1 release trust boundary depends on two categories of secret material: Apple Developer ID signing/notarization credentials, and the Tauri updater key pair. This document is the source of truth for where each secret lives, who can access it, and what to do if one is lost or compromised.

## Secret inventory

All secrets below live only in the GitHub Actions `release` environment (repo → Settings → Environments → `release`), which requires reviewer approval before any job that references them can run. No secret in this table is available to `pull_request`, `pull_request_target`, `workflow_run`, or `workflow_call` triggers, and none is available outside `.github/workflows/release.yaml`.

| Secret | Category | Purpose |
|---|---|---|
| `APPLE_CERTIFICATE_P12_BASE64` | Apple signing | Base64-encoded Developer ID Application `.p12` certificate, imported into an ephemeral per-run keychain. |
| `APPLE_CERTIFICATE_PASSWORD` | Apple signing | Password protecting the `.p12` above. |
| `RELEASE_KEYCHAIN_PASSWORD` | Apple signing | Password for the ephemeral CI keychain created and destroyed within the sign-and-notarize job. |
| `APPLE_SIGNING_IDENTITY` | Apple signing | The `Developer ID Application: <Name> (<Team ID>)` identity string passed to `codesign`. |
| `APPLE_API_KEY_ID` | Apple notarization | App Store Connect API key ID, used with `notarytool` instead of Apple ID/app-password flow. |
| `APPLE_API_ISSUER` | Apple notarization | App Store Connect API issuer ID. |
| `APPLE_API_KEY_BASE64` | Apple notarization | Base64-encoded App Store Connect API private key (`.p8`). |
| `TAURI_SIGNING_PRIVATE_KEY` | Updater | Tauri updater private key, used to sign the updater archive for each release lane. |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Updater | Password protecting the updater private key. |

The updater **public** key is not a secret — it is committed as literal config in `src-tauri/tauri.release.conf.json` and compiled into every shipped app so it can verify updater signatures offline.

## Credential preflight

Before starting a release, confirm:

- The Developer ID Application certificate has not expired and is not within 30 days of expiry (`security find-certificate` locally, or Apple Developer portal).
- The App Store Connect API key referenced by `APPLE_API_KEY_ID` is still active and has the Developer role required for notarization.
- The `release` GitHub Actions environment still has the expected required reviewers configured (`scripts/verify-release-settings.ts` checks this in CI as part of the required-check preflight, but confirm manually before a release you are not fully automating).
- `gh secret list --env release --repo marcusrbrown/mothership` shows all nine secret **names** from the inventory above present in the `release` environment. This only confirms each secret exists (and its last-updated timestamp) — `gh` cannot read or verify secret values, so a stale or wrong value will still pass this check. Treat this as a presence check, not a correctness check; correctness is only proven by a successful sign/notarize run.
- You can decrypt/access the offline backup of the Tauri updater private key (see below) independent of the GitHub secret, in case the secret needs to be re-uploaded.

## Key generation and offline backup

- The Apple Developer ID certificate and App Store Connect API key are generated and managed through the Apple Developer portal; renewal is an Apple-side action, not a repo action.
- The Tauri updater key pair is generated once with `tauri signer generate` and is **not regenerated for routine releases**. Treat it as permanent for the v0.x line: the public key is baked into every shipped v0.x build, and every future v0.x release must be signed by the same private key so existing installs' updater checks continue to trust it.
- Current local custody handoff files (ignored by Git): `.secrets/release/tauri-updater.key` and `.secrets/release/tauri-updater-password.txt`. Move their contents into the `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` secrets in the GitHub `release` environment, then copy them into the offline encrypted backup before deleting the local files.
- Store an offline, encrypted backup of the updater private key and its password outside GitHub (e.g., an offline password manager entry or hardware-backed vault), independent of the GitHub Actions secret. The GitHub secret is the only copy the release workflow can read; the offline backup is the only recovery path if that secret is deleted, corrupted, or the account holding it is compromised.
- Do not store the updater private key, its password, or the Apple `.p12`/`.p8` material in the repository, in any workflow file, in build logs, or in chat/issue history.

## Key rotation constraint

The Tauri updater key is **not rotatable in the normal sense** for v0.x. Existing installed apps only trust updater payloads signed by the public key compiled into their binary. Rotating to a new key pair without a transition plan silently breaks the update path for every existing install — they will neither accept the new signature nor know to look for one.

Apple signing certificates and API keys, by contrast, **are** expected to rotate on Apple's normal renewal cadence (typically annual). Rotate those by generating replacement credentials in the Apple Developer portal, updating the corresponding `release`-environment secrets, and verifying a draft release signs/notarizes successfully before the previous credential expires.

## Updater key compromise or loss

If the Tauri updater private key is lost (no accessible copy in GitHub secrets or offline backup) or compromised (exposed to an untrusted party):

1. **Stop.** Do not publish any further release signed with the compromised/lost key. Treat this as a release-blocking incident, not a routine bug.
2. Determine whether an old-key-signed transition is possible (see below) or whether only the out-of-band reinstall fallback remains.
3. Communicate the incident and remediation path before publishing the next release; do not silently ship a new key with no user-facing notice, since existing installs cannot auto-update through the break.

### Old-key-signed transition procedure

Use this path if the compromised/lost key is still usable for **one more signature** (for example: the private key material is known to be exposed but you still hold a working copy, or a backup was recovered before being fully lost).

1. Generate a new updater key pair with `bun --bun run tauri signer generate`. Store the new private key and password following the same offline-backup and GitHub-secret rules as above.
2. Ship one transition release that:
   - Is still signed by the **old** updater private key (so existing installs' updater checks accept it), and
   - Updates the compiled-in updater public key in `src-tauri/tauri.conf.json` (or the release config) to the **new** public key.
3. Publish the transition release through the normal release pipeline (Unit 6/7 flow) exactly as any other release — no shortcut around signing, notarization, or the environment approval gate.
4. Once the transition release has been out for a reasonable adoption window, retire the old key: remove any remaining references to it, and use only the new key pair for all subsequent releases.
5. Update this document's secret inventory to reflect the new key generation date and any credential rotation performed alongside it.

This procedure only works if the old key can still produce a valid signature. If the old key is fully gone (not just exposed) or its GitHub secret and offline backup are both unavailable, this transition is not possible — fall through to the reinstall fallback.

### Out-of-band reinstall fallback

Use this path if the old key cannot sign a transition release (fully lost, or the only copies were destroyed/inaccessible):

1. Existing installs cannot be moved to a new updater key automatically — there is no in-app updater UX in v0.1, and even if there were, no signature from the new key would validate against the old compiled-in public key.
2. Generate a new updater key pair and ship it in a release built and signed as if it were a first release under the new key (new public key compiled in, new private key used for signing).
3. Publish the new release through the normal signed/notarized macOS release pipeline.
4. Direct existing users to manually download and reinstall the new build from the GitHub Releases page rather than relying on the in-app updater, since the old build has no path to trust the new key's signature.
5. Document the incident (what was lost/compromised, when, and the reinstall instructions given to users) in the repository's release notes for the affected version.

## Roles

- The listed CODEOWNERS release owner (`@marcusrbrown`) is the only reviewer configured on the `release` GitHub Actions environment and is responsible for approving each release run and for holding the offline updater key backup.
- Any change to `.github/workflows/release.yaml`, `.github/workflows/version.yml`, `.github/CODEOWNERS`, the release-critical scripts under `scripts/`, `src-tauri/tauri.conf.json`, `src-tauri/tauri.release.conf.json`, `src-tauri/tauri.dev.conf.json`, the entitlements files, or `src-tauri/capabilities/` requires owner review per `.github/CODEOWNERS`.
