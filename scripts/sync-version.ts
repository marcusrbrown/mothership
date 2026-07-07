#!/usr/bin/env bun
/**
 * Propagates the `package.json` version into every other version surface
 * in the app: `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml`.
 *
 * Runs as part of the Changesets version workflow (after `changeset version`
 * bumps `package.json`) and again as a release preflight check before build,
 * so a stale Tauri/Cargo version can never slip into a release artifact.
 *
 * Usage: bun scripts/sync-version.ts [--check]
 *   --check   Fail if any file is out of sync, without writing changes.
 */
import { readFile, writeFile } from "node:fs/promises";

const PACKAGE_JSON_PATH = new URL("../package.json", import.meta.url);
const TAURI_CONF_PATH = new URL(
  "../src-tauri/tauri.conf.json",
  import.meta.url,
);
const CARGO_TOML_PATH = new URL("../src-tauri/Cargo.toml", import.meta.url);

const SEMVER_PATTERN =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?(?:\+[0-9A-Za-z-.]+)?$/;

export type SyncResult = {
  path: string;
  changed: boolean;
};

export function isValidSemver(version: string): boolean {
  return SEMVER_PATTERN.test(version);
}

/**
 * Updates the root-level `version` field in a Tauri config's JSON, without
 * touching any nested `version` field (e.g. under `bundle` or `plugins`).
 * Parses and re-serializes with 2-space indentation (Tauri config
 * convention) and a trailing newline, preserving the original formatting
 * when no change is needed.
 */
export function syncTauriConfVersion(
  content: string,
  version: string,
): { content: string; changed: boolean } {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content) as Record<string, unknown>;
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not parse tauri.conf.json as JSON: ${cause}`);
  }

  if (typeof parsed.version !== "string") {
    throw new Error(
      'Could not find a top-level "version" field in tauri.conf.json.',
    );
  }

  if (parsed.version === version) {
    return { content, changed: false };
  }

  parsed.version = version;
  return {
    content: `${JSON.stringify(parsed, null, 2)}\n`,
    changed: true,
  };
}

/**
 * Replaces the `version = "..."` field within the `[package]` section of a
 * Cargo.toml's raw text, without touching dependency version fields that
 * happen to share the same key name.
 */
export function syncCargoTomlVersion(
  content: string,
  version: string,
): { content: string; changed: boolean } {
  const lines = content.split("\n");
  let inPackageSection = false;
  let found = false;
  let changed = false;

  const nextLines = lines.map((line) => {
    const sectionMatch = /^\s*\[([^\]]+)]\s*$/.exec(line);
    if (sectionMatch) {
      inPackageSection = sectionMatch[1] === "package";
      return line;
    }
    if (!inPackageSection) return line;

    const versionMatch = /^(\s*version\s*=\s*")([^"]*)(".*)$/.exec(line);
    if (!versionMatch) return line;

    found = true;
    if (versionMatch[2] === version) return line;
    changed = true;
    return `${versionMatch[1]}${version}${versionMatch[3]}`;
  });

  if (!found) {
    throw new Error(
      'Could not find a "version" field in the [package] section of Cargo.toml.',
    );
  }

  return { content: changed ? nextLines.join("\n") : content, changed };
}

async function readFileOrThrow(url: URL, label: string): Promise<string> {
  try {
    return await readFile(url, "utf8");
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read ${label} at ${url.pathname}: ${cause}`);
  }
}

export async function syncVersion(
  options: { check?: boolean } = {},
): Promise<SyncResult[]> {
  const packageJsonRaw = await readFileOrThrow(
    PACKAGE_JSON_PATH,
    "package.json",
  );
  const packageJson = JSON.parse(packageJsonRaw) as { version?: unknown };
  const version = packageJson.version;

  if (typeof version !== "string" || !isValidSemver(version)) {
    throw new Error(
      `package.json version "${String(version)}" is not valid semver.`,
    );
  }

  const targets: Array<{
    url: URL;
    label: string;
    sync: (
      content: string,
      version: string,
    ) => { content: string; changed: boolean };
  }> = [
    {
      url: TAURI_CONF_PATH,
      label: "tauri.conf.json",
      sync: syncTauriConfVersion,
    },
    { url: CARGO_TOML_PATH, label: "Cargo.toml", sync: syncCargoTomlVersion },
  ];

  const results: SyncResult[] = [];

  for (const target of targets) {
    const raw = await readFileOrThrow(target.url, target.label);
    const { content, changed } = target.sync(raw, version);

    if (changed && !options.check) {
      await writeFile(target.url, content, "utf8");
    }

    results.push({ path: target.url.pathname, changed });
  }

  return results;
}

async function main(): Promise<void> {
  const checkOnly = process.argv.includes("--check");
  const results = await syncVersion({ check: checkOnly });
  const outOfSync = results.filter((r) => r.changed);

  if (checkOnly && outOfSync.length > 0) {
    console.error("❌ Version sync check FAILED. Out of sync:");
    for (const result of outOfSync) {
      console.error(`  - ${result.path}`);
    }
    process.exit(1);
  }

  if (outOfSync.length === 0) {
    console.log("✅ All version surfaces already in sync.");
  } else {
    console.log("✅ Synced version to:");
    for (const result of outOfSync) {
      console.log(`  - ${result.path}`);
    }
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
