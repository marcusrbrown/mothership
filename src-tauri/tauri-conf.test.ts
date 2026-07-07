import { describe, expect, test } from "bun:test";
import prodConfig from "./tauri.conf.json";
import devConfig from "./tauri.dev.conf.json";
import releaseConfig from "./tauri.release.conf.json";

type CspMap = Record<string, string>;

/**
 * Extracts and validates the CSP map from a Tauri config. Returns null if the
 * config has no CSP (i.e. inherits from a base config). Throws if the CSP is
 * present but malformed — including if any directive value is not a string,
 * so a downstream consumer never receives a silently-miscast CspMap.
 */
function getCsp(config: unknown): CspMap | null {
  const csp = (config as { app?: { security?: { csp?: unknown } } }).app
    ?.security?.csp;
  if (csp === null || csp === undefined) return null;
  if (typeof csp !== "object") {
    throw new Error("csp must be an object or null");
  }
  for (const [directive, value] of Object.entries(csp)) {
    if (typeof value !== "string") {
      throw new Error(
        `csp directive "${directive}" must be a string, got ${typeof value}`,
      );
    }
  }
  return csp as CspMap;
}

const REQUIRED_FLOOR_DIRECTIVES: Record<string, string> = {
  "default-src": "'self'",
  "script-src": "'self'",
  "form-action": "'none'",
  "base-uri": "'self'",
  "object-src": "'none'",
};

// Placeholder value shipped in tauri.release.conf.json until a real updater
// key pair is generated (see docs/release/signing-key-custody.md). CI and
// this test suite must fail closed if it ever reaches a release build.
const PLACEHOLDER_UPDATER_PUBKEY =
  "REPLACE_WITH_GENERATED_TAURI_UPDATER_PUBLIC_KEY";

// Tauri updater public keys are base64-encoded minisign keys: base64
// alphabet only, no whitespace, and long enough to rule out trivial
// placeholders slipping through as valid-looking strings.
const BASE64_ISH_PUBKEY_PATTERN = /^[A-Za-z0-9+/]{40,}={0,2}$/;

function allValues(csp: CspMap): string[] {
  return Object.values(csp);
}

describe("production tauri.conf.json CSP", () => {
  const csp = getCsp(prodConfig);

  test("csp is not null in production config", () => {
    expect(csp).not.toBeNull();
  });

  test("directive floor is present with exact required values", () => {
    for (const [directive, value] of Object.entries(
      REQUIRED_FLOOR_DIRECTIVES,
    )) {
      expect(csp?.[directive]).toBe(value);
    }
  });

  test("connect-src allows exact Tauri IPC origins", () => {
    const connectSrc = csp?.["connect-src"] ?? "";
    expect(connectSrc).toContain("ipc:");
    expect(connectSrc).toContain("http://ipc.localhost");
  });

  test("rejects bare localhost, wildcard hosts, and dev-only Vite ports", () => {
    for (const value of allValues(csp ?? {})) {
      expect(value).not.toMatch(/localhost:1420|localhost:1421/);
      // Port wildcards on explicit loopback literals (e.g. `127.0.0.1:*`) are
      // allowed; wildcard *hosts* (schemes/domains) are not.
      const hostWildcards = value
        .split(/\s+/)
        .filter(
          (tok) =>
            tok.includes("*") &&
            !/^(https?|wss?):\/\/(127\.0\.0\.1|\[::1\]):\*$/.test(tok),
        );
      expect(hostWildcards).toEqual([]);
    }
  });

  test("does not use scheme-less bare hostnames for loopback", () => {
    const connectSrc = csp?.["connect-src"] ?? "";
    // every 127.0.0.1 / ::1 reference must be prefixed with a scheme
    const loopbackTokens = connectSrc
      .split(/\s+/)
      .filter((tok) => tok.includes("127.0.0.1") || tok.includes("::1"));
    for (const token of loopbackTokens) {
      expect(token).toMatch(/^(https?|wss?):\/\//);
    }
  });

  test("script-src has no unsafe broadening", () => {
    const scriptSrc = csp?.["script-src"] ?? "";
    expect(scriptSrc).not.toContain("unsafe-inline");
    expect(scriptSrc).not.toContain("unsafe-eval");
    expect(scriptSrc).not.toContain("*");
  });
});

describe("dev tauri.dev.conf.json CSP", () => {
  const csp = getCsp(devConfig);

  test("dev csp is not null and carries the same directive floor", () => {
    expect(csp).not.toBeNull();
    for (const [directive, value] of Object.entries(
      REQUIRED_FLOOR_DIRECTIVES,
    )) {
      expect(csp?.[directive]).toBe(value);
    }
  });

  test("dev csp permits Vite dev server / HMR only in the dev-only override", () => {
    const connectSrc = csp?.["connect-src"] ?? "";
    expect(connectSrc).toContain("localhost:1420");
    expect(connectSrc).toContain("localhost:1421");
  });

  test("dev override does not leak into production config", () => {
    const prodConnectSrc = getCsp(prodConfig)?.["connect-src"] ?? "";
    expect(prodConnectSrc).not.toContain("1420");
    expect(prodConnectSrc).not.toContain("1421");
  });
});

describe("tauri.release.conf.json updater pubkey", () => {
  const pubkey = (
    releaseConfig as {
      plugins?: { updater?: { pubkey?: unknown } };
    }
  ).plugins?.updater?.pubkey;

  test("updater pubkey is present and not the placeholder", () => {
    expect(typeof pubkey).toBe("string");
    expect(pubkey).not.toBe(PLACEHOLDER_UPDATER_PUBKEY);
  });

  test("updater pubkey has a plausible base64 shape", () => {
    expect(typeof pubkey).toBe("string");
    expect(pubkey as string).toMatch(BASE64_ISH_PUBKEY_PATTERN);
  });
});

describe("tauri.release.conf.json macOS deployment target", () => {
  test("minimumSystemVersion is not the unsupported pre-13.0 floor", () => {
    const minimumSystemVersion = (
      releaseConfig as {
        bundle?: { macOS?: { minimumSystemVersion?: unknown } };
      }
    ).bundle?.macOS?.minimumSystemVersion;
    if (minimumSystemVersion === undefined) return;
    expect(minimumSystemVersion).not.toBe("10.15");
  });
});
