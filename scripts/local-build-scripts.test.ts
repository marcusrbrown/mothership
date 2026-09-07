import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

/**
 * Policy test for the local `build`/`build:dmg` npm scripts (not release
 * CI, which drives `tauri build` directly — see .github/workflows/release.yaml).
 *
 * Approved fix: the default local `bun run build` must bundle ONLY the
 * macOS `.app` (no DMG, no Finder/hdiutil popup); `bun run build:dmg` is
 * the explicit opt-in for the previous full `.app` + `.dmg` local package
 * behavior. Both must keep the existing sidecar build and release config
 * (`src-tauri/tauri.release.conf.json`, `createUpdaterArtifacts:false`
 * override) unchanged — this fix only narrows/adds a `--bundles` CLI
 * target, it does not touch release signing config or CI.
 */

const PACKAGE_JSON_PATH = new URL("../package.json", import.meta.url);

async function readScripts(): Promise<Record<string, string>> {
  const raw = await readFile(PACKAGE_JSON_PATH, "utf8");
  const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
  if (!pkg.scripts) throw new Error("package.json has no scripts section");
  return pkg.scripts;
}

describe("local build scripts: app-only default, explicit dmg opt-in", () => {
  test("happy path: `build` passes --bundles app to tauri build", async () => {
    const scripts = await readScripts();
    expect(scripts.build).toMatch(/--bundles\s+app\b/);
  });

  test("error path: `build` must not be able to select dmg — no bare `--bundles dmg`, `app,dmg`, or `dmg,app` anywhere in the command", async () => {
    const scripts = await readScripts();
    const build = scripts.build ?? "";
    expect(build).not.toMatch(/--bundles\s+(dmg\b|app,\s*dmg\b|dmg,\s*app\b)/);
    // Belt-and-suspenders: the literal substring "dmg" must not appear
    // anywhere in the default build command at all.
    expect(build).not.toContain("dmg");
  });

  test("happy path: `build:dmg` exists and passes --bundles app,dmg to tauri build", async () => {
    const scripts = await readScripts();
    expect(scripts["build:dmg"]).toBeDefined();
    expect(scripts["build:dmg"] as string).toMatch(/--bundles\s+app,dmg\b/);
  });

  test("regression: both `build` and `build:dmg` keep the existing sidecar build step", async () => {
    const scripts = await readScripts();
    for (const name of ["build", "build:dmg"]) {
      expect(scripts[name]).toContain("bun run sidecar:build");
    }
  });

  test("regression: both `build` and `build:dmg` keep the release config and unsigned-updater override untouched", async () => {
    const scripts = await readScripts();
    for (const name of ["build", "build:dmg"]) {
      const cmd = scripts[name] as string;
      expect(cmd).toContain("--config src-tauri/tauri.release.conf.json");
      expect(cmd).toContain('"createUpdaterArtifacts":false');
    }
  });

  test("regression: both scripts still invoke `bun --bun run tauri build`, no separate release path introduced", async () => {
    const scripts = await readScripts();
    for (const name of ["build", "build:dmg"]) {
      expect(scripts[name]).toContain("bun --bun run tauri build");
    }
  });
});
