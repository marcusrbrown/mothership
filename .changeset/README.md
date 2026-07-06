# Changesets

This folder is managed by [`@changesets/cli`](https://github.com/changesets/changesets).

Mothership is a **private desktop app with no npm publish step**. Changesets is used only for:

- objective semver bumps driven by PR-authored changeset files (`bunx changeset`)
- generating `CHANGELOG.md` entries when versions are bumped (`bunx changeset version`)

`bunx changeset version` also runs `scripts/sync-version.ts`, which propagates the bumped
`package.json` version into `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml` so every
version surface stays in sync. There is no `changeset publish` step — releases ship as signed
Tauri bundles, not npm packages.

See the [common questions doc](https://github.com/changesets/changesets/blob/main/docs/common-questions.md)
for general Changesets usage.
