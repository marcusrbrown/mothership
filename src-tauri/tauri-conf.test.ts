import { describe, expect, test } from "bun:test";
import prodConfig from "./tauri.conf.json";
import devConfig from "./tauri.dev.conf.json";

type CspMap = Record<string, string>;

function getCsp(config: unknown): CspMap | null {
  const csp = (config as { app?: { security?: { csp?: unknown } } }).app
    ?.security?.csp;
  if (csp === null || csp === undefined) return null;
  if (typeof csp !== "object") {
    throw new Error("csp must be an object or null");
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

const DISALLOWED_PATTERNS = [
  /\blocalhost\b/, // production must not reference bare `localhost`
  /\*/, // no wildcard hosts
  /(?<![a-z0-9-]):\/\//i, // scheme-less-looking artifacts (defensive check)
];

function allValues(csp: CspMap): string[] {
  return Object.values(csp);
}

describe("production tauri.conf.json CSP", () => {
  const csp = getCsp(prodConfig);

  test("csp is not null in production config", () => {
    expect(csp).not.toBeNull();
  });

  test("directive floor is present with exact required values", () => {
    for (const [directive, value] of Object.entries(REQUIRED_FLOOR_DIRECTIVES)) {
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
        .filter((tok) => tok.includes("*") && !/^(https?|wss?):\/\/(127\.0\.0\.1|\[::1\]):\*$/.test(tok));
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
    for (const [directive, value] of Object.entries(REQUIRED_FLOOR_DIRECTIVES)) {
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
