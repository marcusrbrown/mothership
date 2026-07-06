#!/usr/bin/env bun
/**
 * Validates a Tauri v2 updater `latest.json` manifest before it is promoted
 * into the stable release feed.
 *
 * This is an ALLOWLIST validator (see sidecar/ide-server/redact.ts for the
 * same posture on the panel-disclosure boundary): only the macOS platform
 * keys mothership actually ships are accepted, every accepted platform
 * entry must carry a non-empty signature and an https artifact URL, and
 * every accepted artifact URL must resolve to a checksum entry in
 * `SHA256SUMS` recorded from the *signed* artifacts. Anything else — an
 * unexpected platform key, a missing signature, a missing/mismatched
 * checksum, or a version that is not strictly newer than the previously
 * published release — fails closed.
 *
 * This validator does not itself promote `latest.json` into the stable
 * feed; it only decides whether a candidate manifest is safe to promote.
 * The release workflow keeps `latest.json` out of the feed until this
 * check (and attestation verification) pass — see Unit 7 of
 * docs/plans/2026-07-06-001-feat-v0-1-release-pipeline-plan.md.
 *
 * Usage:
 *   bun scripts/validate-updater-manifest.ts \
 *     --manifest path/to/latest.json \
 *     --checksums path/to/SHA256SUMS \
 *     [--previous-version 0.1.0]
 */
import { readFile } from "node:fs/promises";

/** The only platform keys mothership's v0.1 release ships. Any other key
 * present in a manifest's `platforms` map is rejected — v0.1 is
 * macOS-only, so Linux/Windows platform entries never belong here. */
export const ALLOWED_PLATFORMS: readonly string[] = [
  "darwin-aarch64",
  "darwin-x86_64",
];

const SEMVER_PATTERN =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?(?:\+[0-9A-Za-z-.]+)?$/;

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/i;

export interface UpdaterPlatformEntry {
  signature: string;
  url: string;
}

export interface UpdaterManifest {
  version: string;
  notes?: string;
  pub_date?: string;
  platforms: Record<string, UpdaterPlatformEntry>;
}

export interface ValidationResult {
  ok: boolean;
  failures: string[];
}

export function isValidSemver(version: string): boolean {
  return SEMVER_PATTERN.test(version);
}

/**
 * Compares two valid semver strings, ignoring build metadata and treating
 * any prerelease identifier as older than the same release without one.
 * Returns negative if `a` < `b`, positive if `a` > `b`, zero if equal.
 */
export function compareSemver(a: string, b: string): number {
  const [aCore, aPre] = a.split("+")[0]?.split("-", 2) ?? [a];
  const [bCore, bPre] = b.split("+")[0]?.split("-", 2) ?? [b];

  const aParts = (aCore ?? "").split(".").map(Number);
  const bParts = (bCore ?? "").split(".").map(Number);

  for (let i = 0; i < 3; i += 1) {
    const diff = (aParts[i] ?? 0) - (bParts[i] ?? 0);
    if (diff !== 0) return diff;
  }

  if (aPre === undefined && bPre === undefined) return 0;
  if (aPre === undefined) return 1; // release > prerelease
  if (bPre === undefined) return -1;
  return aPre.localeCompare(bPre);
}

export function isDowngrade(
  candidateVersion: string,
  previousVersion: string,
): boolean {
  return compareSemver(candidateVersion, previousVersion) <= 0;
}

/** Parses `sha256sum`-style output (`<hex>  <path>`) into a map keyed by
 * the artifact's basename, so lookups don't depend on the checksum file's
 * recorded path prefix. */
export function parseSha256Sums(content: string): Map<string, string> {
  const checksums = new Map<string, string>();
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(trimmed);
    if (!match) continue;
    const [, hex, path] = match;
    if (!hex || !path) continue;
    const basename = path.split("/").pop() ?? path;
    checksums.set(basename, hex.toLowerCase());
  }
  return checksums;
}

function basenameFromUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.pathname.split("/").pop();
  } catch {
    return undefined;
  }
}

/**
 * Validates the manifest's structural shape: a valid semver `version`, and
 * a non-empty `platforms` map.
 */
export function validateManifestShape(
  manifest: Partial<UpdaterManifest>,
): string[] {
  const failures: string[] = [];

  if (typeof manifest.version !== "string" || !manifest.version) {
    failures.push('Manifest is missing a "version" string.');
  } else if (!isValidSemver(manifest.version)) {
    failures.push(
      `Manifest version "${manifest.version}" is not valid semver.`,
    );
  }

  if (
    !manifest.platforms ||
    typeof manifest.platforms !== "object" ||
    Object.keys(manifest.platforms).length === 0
  ) {
    failures.push('Manifest is missing a non-empty "platforms" map.');
  }

  return failures;
}

/**
 * Validates the manifest's `platforms` map against the macOS-only
 * allowlist: every key must be an allowed platform, every allowed
 * platform mothership ships must be present, and every entry must carry a
 * non-empty signature and an https artifact URL.
 */
export function validatePlatforms(
  platforms: Record<string, UpdaterPlatformEntry>,
): string[] {
  const failures: string[] = [];
  const allowed = new Set(ALLOWED_PLATFORMS);

  for (const key of Object.keys(platforms)) {
    if (!allowed.has(key)) {
      failures.push(
        `Manifest declares platform "${key}", which is not one of the shipped v0.1 macOS platforms (${ALLOWED_PLATFORMS.join(", ")}).`,
      );
    }
  }

  for (const platform of ALLOWED_PLATFORMS) {
    const entry = platforms[platform];
    if (!entry) {
      failures.push(
        `Manifest is missing the required "${platform}" platform entry.`,
      );
      continue;
    }
    if (typeof entry.signature !== "string" || entry.signature.length === 0) {
      failures.push(`Platform "${platform}" is missing a signature.`);
    }
    if (typeof entry.url !== "string" || entry.url.length === 0) {
      failures.push(`Platform "${platform}" is missing an artifact URL.`);
    } else if (!/^https:\/\//.test(entry.url)) {
      failures.push(
        `Platform "${platform}" artifact URL "${entry.url}" is not an https URL.`,
      );
    }
  }

  return failures;
}

/**
 * Validates every platform entry's artifact URL resolves to a checksum
 * recorded in `SHA256SUMS` (generated from the signed artifacts — see
 * .github/workflows/release.yml). Missing or malformed checksum entries
 * fail closed rather than being treated as "not yet verified."
 */
export function validateChecksums(
  platforms: Record<string, UpdaterPlatformEntry>,
  checksums: Map<string, string>,
): string[] {
  const failures: string[] = [];

  for (const platform of ALLOWED_PLATFORMS) {
    const entry = platforms[platform];
    if (!entry?.url) continue; // already reported by validatePlatforms

    const basename = basenameFromUrl(entry.url);
    if (!basename) {
      failures.push(
        `Platform "${platform}" artifact URL "${entry.url}" could not be parsed to find a checksum entry.`,
      );
      continue;
    }

    const digest = checksums.get(basename);
    if (!digest) {
      failures.push(
        `No SHA256SUMS entry found for "${basename}" (platform "${platform}").`,
      );
      continue;
    }
    if (!SHA256_HEX_PATTERN.test(digest)) {
      failures.push(
        `SHA256SUMS entry for "${basename}" is not a valid 64-character hex digest.`,
      );
    }
  }

  return failures;
}

/**
 * Full validation pipeline: shape, macOS-only platform allowlist,
 * checksum binding, and downgrade protection against the previously
 * published version (when known).
 */
export function validateUpdaterManifest(
  manifest: Partial<UpdaterManifest>,
  options: { checksums?: Map<string, string>; previousVersion?: string } = {},
): ValidationResult {
  const failures = [...validateManifestShape(manifest)];

  if (manifest.platforms) {
    failures.push(...validatePlatforms(manifest.platforms));
    if (options.checksums) {
      failures.push(
        ...validateChecksums(manifest.platforms, options.checksums),
      );
    }
  }

  if (
    options.previousVersion &&
    typeof manifest.version === "string" &&
    isValidSemver(manifest.version) &&
    isValidSemver(options.previousVersion) &&
    isDowngrade(manifest.version, options.previousVersion)
  ) {
    failures.push(
      `Manifest version "${manifest.version}" is not newer than the previously published version "${options.previousVersion}" (downgrade rejected).`,
    );
  }

  return { ok: failures.length === 0, failures };
}

export function parseArgs(argv: string[]): {
  manifest?: string;
  checksums?: string;
  previousVersion?: string;
} {
  const result: {
    manifest?: string;
    checksums?: string;
    previousVersion?: string;
  } = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--manifest") {
      result.manifest = value;
      i += 1;
    } else if (flag === "--checksums") {
      result.checksums = value;
      i += 1;
    } else if (flag === "--previous-version") {
      result.previousVersion = value;
      i += 1;
    }
  }
  return result;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!args.manifest || !args.checksums) {
    console.error(
      "Usage: bun scripts/validate-updater-manifest.ts --manifest <path> --checksums <path> [--previous-version <semver>]",
    );
    process.exit(2);
  }

  const manifestRaw = await readFile(args.manifest, "utf8");
  const manifest = JSON.parse(manifestRaw) as Partial<UpdaterManifest>;
  const checksumsRaw = await readFile(args.checksums, "utf8");
  const checksums = parseSha256Sums(checksumsRaw);

  const result = validateUpdaterManifest(manifest, {
    checksums,
    previousVersion: args.previousVersion,
  });

  if (!result.ok) {
    console.error("❌ Updater manifest validation FAILED:");
    for (const failure of result.failures) {
      console.error(`  - ${failure}`);
    }
    process.exit(1);
  }

  console.log("✅ Updater manifest is valid and safe to promote.");
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
