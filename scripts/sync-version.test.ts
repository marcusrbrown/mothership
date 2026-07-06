import { describe, expect, test } from "bun:test";
import {
  isValidSemver,
  syncCargoTomlVersion,
  syncTauriConfVersion,
} from "./sync-version";

describe("isValidSemver", () => {
  test("happy path: accepts plain semver", () => {
    expect(isValidSemver("1.2.3")).toBe(true);
  });

  test("edge case: accepts prerelease and build metadata", () => {
    expect(isValidSemver("1.2.3-beta.1")).toBe(true);
    expect(isValidSemver("1.2.3+build.7")).toBe(true);
  });

  test("error path: rejects invalid semver", () => {
    expect(isValidSemver("1.2")).toBe(false);
    expect(isValidSemver("v1.2.3")).toBe(false);
    expect(isValidSemver("not-a-version")).toBe(false);
  });
});

describe("syncTauriConfVersion", () => {
  const config = `{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "mothership",
  "version": "0.1.0",
  "identifier": "com.marcusrbrown.mothership"
}`;

  test("happy path: updates the version field", () => {
    const result = syncTauriConfVersion(config, "0.2.0");
    expect(result.changed).toBe(true);
    expect(result.content).toContain('"version": "0.2.0"');
  });

  test("edge case: matching version is a no-op", () => {
    const result = syncTauriConfVersion(config, "0.1.0");
    expect(result.changed).toBe(false);
    expect(result.content).toBe(config);
  });

  test("error path: missing version field fails clearly", () => {
    expect(() =>
      syncTauriConfVersion('{"productName": "mothership"}', "0.2.0"),
    ).toThrow(/Could not find a top-level "version" field/);
  });
});

describe("syncCargoTomlVersion", () => {
  const cargoToml = `[package]
name = "mothership"
version = "0.1.0"
edition = "2021"

[dependencies]
tauri = { version = "2", features = [] }
`;

  test("happy path: updates the [package] version only", () => {
    const result = syncCargoTomlVersion(cargoToml, "0.2.0");
    expect(result.changed).toBe(true);
    expect(result.content).toContain('version = "0.2.0"');
    expect(result.content).toContain('tauri = { version = "2"');
  });

  test("edge case: matching version is a no-op", () => {
    const result = syncCargoTomlVersion(cargoToml, "0.1.0");
    expect(result.changed).toBe(false);
    expect(result.content).toBe(cargoToml);
  });

  test("edge case: does not touch dependency version fields sharing the key name", () => {
    const toml = `[package]
name = "mothership"
version = "1.0.0"

[dependencies.foo]
version = "1.0.0"
`;
    const result = syncCargoTomlVersion(toml, "1.1.0");
    expect(result.content).toContain(
      '[package]\nname = "mothership"\nversion = "1.1.0"',
    );
    expect(result.content).toContain('[dependencies.foo]\nversion = "1.0.0"');
  });

  test("error path: missing [package] version field fails clearly", () => {
    expect(() =>
      syncCargoTomlVersion('[package]\nname = "mothership"\n', "0.2.0"),
    ).toThrow(/Could not find a "version" field/);
  });
});
