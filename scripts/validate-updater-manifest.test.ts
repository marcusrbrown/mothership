import { describe, expect, test } from "bun:test";
import {
  ALLOWED_PLATFORMS,
  type UpdaterPlatformEntry,
  compareSemver,
  isDowngrade,
  isValidSemver,
  parseArgs,
  parseSha256Sums,
  validateChecksums,
  validateManifestShape,
  validatePlatforms,
  validateUpdaterManifest,
} from "./validate-updater-manifest";

const VALID_PLATFORMS: Record<string, UpdaterPlatformEntry> = {
  "darwin-aarch64": {
    signature: "sig-arm64",
    url: "https://github.com/marcusrbrown/mothership/releases/download/v0.2.0/mothership-aarch64-apple-darwin.app.tar.gz",
  },
  "darwin-x86_64": {
    signature: "sig-x64",
    url: "https://github.com/marcusrbrown/mothership/releases/download/v0.2.0/mothership-x86_64-apple-darwin.app.tar.gz",
  },
};

const VALID_CHECKSUMS = new Map<string, string>([
  ["mothership-aarch64-apple-darwin.app.tar.gz", "a".repeat(64)],
  ["mothership-x86_64-apple-darwin.app.tar.gz", "b".repeat(64)],
]);

function validManifest() {
  return { version: "0.2.0", platforms: { ...VALID_PLATFORMS } };
}

describe("isValidSemver", () => {
  test("happy path: accepts plain semver", () => {
    expect(isValidSemver("0.2.0")).toBe(true);
  });

  test("edge case: accepts prerelease and build metadata", () => {
    expect(isValidSemver("0.2.0-rc.1")).toBe(true);
    expect(isValidSemver("0.2.0+build.3")).toBe(true);
  });

  test("error path: rejects malformed versions", () => {
    expect(isValidSemver("v0.2.0")).toBe(false);
    expect(isValidSemver("0.2")).toBe(false);
    expect(isValidSemver("latest")).toBe(false);
  });
});

describe("compareSemver", () => {
  test("happy path: orders by major/minor/patch", () => {
    expect(compareSemver("0.2.0", "0.1.0")).toBeGreaterThan(0);
    expect(compareSemver("0.1.0", "0.2.0")).toBeLessThan(0);
    expect(compareSemver("0.2.0", "0.2.0")).toBe(0);
  });

  test("edge case: release outranks its own prerelease", () => {
    expect(compareSemver("0.2.0", "0.2.0-rc.1")).toBeGreaterThan(0);
    expect(compareSemver("0.2.0-rc.1", "0.2.0")).toBeLessThan(0);
  });

  test("edge case: numeric prerelease identifiers compare numerically, not lexically", () => {
    expect(compareSemver("0.2.0-rc.2", "0.2.0-rc.10")).toBeLessThan(0);
    expect(compareSemver("0.2.0-rc.10", "0.2.0-rc.2")).toBeGreaterThan(0);
  });

  test("edge case: numeric identifiers have lower precedence than alphanumeric", () => {
    expect(compareSemver("0.2.0-rc.1", "0.2.0-rc.alpha")).toBeLessThan(0);
    expect(compareSemver("0.2.0-rc.alpha", "0.2.0-rc.1")).toBeGreaterThan(0);
  });

  test("edge case: alphanumeric prerelease identifiers compare lexically", () => {
    expect(compareSemver("0.2.0-alpha", "0.2.0-beta")).toBeLessThan(0);
  });

  test("edge case: shorter prerelease has lower precedence when equal so far", () => {
    expect(compareSemver("0.2.0-rc", "0.2.0-rc.1")).toBeLessThan(0);
    expect(compareSemver("0.2.0-rc.1", "0.2.0-rc")).toBeGreaterThan(0);
  });

  test("regression: prerelease identifiers containing hyphens are preserved in full, not truncated at the first hyphen", () => {
    expect(compareSemver("1.0.0-alpha-beta", "1.0.0-alpha")).toBeGreaterThan(0);
    expect(compareSemver("1.0.0-alpha", "1.0.0-alpha-beta")).toBeLessThan(0);
    expect(isDowngrade("1.0.0-alpha", "1.0.0-alpha-beta")).toBe(true);
    expect(isDowngrade("1.0.0-alpha-beta", "1.0.0-alpha")).toBe(false);
  });
});

describe("isDowngrade", () => {
  test("happy path: newer version is not a downgrade", () => {
    expect(isDowngrade("0.2.0", "0.1.0")).toBe(false);
  });

  test("error path: equal or older version is a downgrade", () => {
    expect(isDowngrade("0.1.0", "0.1.0")).toBe(true);
    expect(isDowngrade("0.1.0", "0.2.0")).toBe(true);
  });
});

describe("parseSha256Sums", () => {
  test("happy path: parses shasum-style output keyed by basename", () => {
    const parsed = parseSha256Sums(
      `${"a".repeat(64)}  signed/aarch64-apple-darwin/mothership.app.tar.gz\n${"b".repeat(64)}  signed/x86_64-apple-darwin/mothership.app.tar.gz\n`,
    );
    // Same basename recorded twice under different dirs: last entry wins.
    expect(parsed.get("mothership.app.tar.gz")).toBe("b".repeat(64));
  });

  test("edge case: distinguishes files by their own basename", () => {
    const parsed = parseSha256Sums(
      `${"a".repeat(64)}  signed/arm/app.tar.gz\n${"b".repeat(64)}  signed/x64/other.tar.gz\n`,
    );
    expect(parsed.get("app.tar.gz")).toBe("a".repeat(64));
    expect(parsed.get("other.tar.gz")).toBe("b".repeat(64));
  });

  test("edge case: ignores blank lines and malformed rows", () => {
    const parsed = parseSha256Sums(
      `\n  \nnot-a-checksum-line\n${"c".repeat(64)}  file.dmg\n`,
    );
    expect(parsed.size).toBe(1);
    expect(parsed.get("file.dmg")).toBe("c".repeat(64));
  });
});

describe("validateManifestShape", () => {
  test("happy path: accepts a complete manifest", () => {
    expect(validateManifestShape(validManifest())).toEqual([]);
  });

  test("error path: rejects missing version", () => {
    const failures = validateManifestShape({ platforms: VALID_PLATFORMS });
    expect(failures.some((f) => f.includes('"version"'))).toBe(true);
  });

  test("error path: rejects invalid version", () => {
    const failures = validateManifestShape({
      version: "not-semver",
      platforms: VALID_PLATFORMS,
    });
    expect(failures.some((f) => f.includes("not valid semver"))).toBe(true);
  });

  test("error path: rejects missing/empty platforms", () => {
    expect(
      validateManifestShape({ version: "0.2.0" }).some((f) =>
        f.includes('"platforms"'),
      ),
    ).toBe(true);
    expect(
      validateManifestShape({ version: "0.2.0", platforms: {} }).some((f) =>
        f.includes('"platforms"'),
      ),
    ).toBe(true);
  });
});

describe("validatePlatforms", () => {
  test("happy path: accepts exactly the macOS-only allowlist", () => {
    expect(validatePlatforms(VALID_PLATFORMS)).toEqual([]);
  });

  test("edge case: rejects Linux/Windows platform entries", () => {
    const failures = validatePlatforms({
      ...VALID_PLATFORMS,
      "linux-x86_64": { signature: "sig", url: "https://example.com/x.tar.gz" },
    });
    expect(failures.some((f) => f.includes('"linux-x86_64"'))).toBe(true);
  });

  test("error path: rejects missing required platform entry", () => {
    const partial: Record<string, UpdaterPlatformEntry> = {
      "darwin-aarch64": {
        signature: "sig-arm64",
        url: "https://github.com/marcusrbrown/mothership/releases/download/v0.2.0/mothership-aarch64-apple-darwin.app.tar.gz",
      },
    };
    const failures = validatePlatforms(partial);
    expect(
      failures.some((f) => f.includes('missing the required "darwin-x86_64"')),
    ).toBe(true);
  });

  test("error path: rejects missing signature", () => {
    const failures = validatePlatforms({
      ...VALID_PLATFORMS,
      "darwin-aarch64": {
        signature: "",
        url: "https://github.com/marcusrbrown/mothership/releases/download/v0.2.0/mothership-aarch64-apple-darwin.app.tar.gz",
      },
    });
    expect(failures.some((f) => f.includes("missing a signature"))).toBe(true);
  });

  test("error path: rejects missing or non-https artifact URL", () => {
    const failuresMissing = validatePlatforms({
      ...VALID_PLATFORMS,
      "darwin-aarch64": { signature: "sig", url: "" },
    });
    expect(
      failuresMissing.some((f) => f.includes("missing an artifact URL")),
    ).toBe(true);

    const failuresHttp = validatePlatforms({
      ...VALID_PLATFORMS,
      "darwin-aarch64": {
        signature: "sig",
        url: "http://example.com/x.tar.gz",
      },
    });
    expect(failuresHttp.some((f) => f.includes("not an https URL"))).toBe(true);
  });
});

describe("validateChecksums", () => {
  test("happy path: accepts matching checksum entries", () => {
    expect(validateChecksums(VALID_PLATFORMS, VALID_CHECKSUMS)).toEqual([]);
  });

  test("error path: rejects a mismatched/missing checksum file entry", () => {
    const failures = validateChecksums(VALID_PLATFORMS, new Map());
    expect(failures.length).toBe(2);
    expect(failures.every((f) => f.includes("No SHA256SUMS entry found"))).toBe(
      true,
    );
  });

  test("error path: rejects a malformed digest", () => {
    const checksums = new Map(VALID_CHECKSUMS);
    checksums.set("mothership-aarch64-apple-darwin.app.tar.gz", "not-hex");
    const failures = validateChecksums(VALID_PLATFORMS, checksums);
    expect(
      failures.some((f) => f.includes("not a valid 64-character hex digest")),
    ).toBe(true);
  });
});

describe("validateUpdaterManifest", () => {
  test("happy path: accepts a complete macOS release manifest", () => {
    const result = validateUpdaterManifest(validManifest(), {
      checksums: VALID_CHECKSUMS,
      previousVersion: "0.1.0",
    });
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });

  test("edge case: rejects Linux/Windows entries while v0.1 is macOS-only", () => {
    const result = validateUpdaterManifest(
      {
        version: "0.2.0",
        platforms: {
          ...VALID_PLATFORMS,
          "windows-x86_64": {
            signature: "sig",
            url: "https://example.com/x.zip",
          },
        },
      },
      { checksums: VALID_CHECKSUMS },
    );
    expect(result.ok).toBe(false);
    expect(result.failures.some((f) => f.includes('"windows-x86_64"'))).toBe(
      true,
    );
  });

  test("error path: rejects missing signature", () => {
    const manifest = validManifest();
    manifest.platforms["darwin-aarch64"] = {
      signature: "",
      url: "https://github.com/marcusrbrown/mothership/releases/download/v0.2.0/mothership-aarch64-apple-darwin.app.tar.gz",
    };
    const result = validateUpdaterManifest(manifest, {
      checksums: VALID_CHECKSUMS,
    });
    expect(result.ok).toBe(false);
    expect(result.failures.some((f) => f.includes("missing a signature"))).toBe(
      true,
    );
  });

  test("error path: rejects missing artifact URL", () => {
    const manifest = validManifest();
    manifest.platforms["darwin-x86_64"] = {
      signature: "sig-x64",
      url: "",
    };
    const result = validateUpdaterManifest(manifest, {
      checksums: VALID_CHECKSUMS,
    });
    expect(result.ok).toBe(false);
    expect(
      result.failures.some((f) => f.includes("missing an artifact URL")),
    ).toBe(true);
  });

  test("error path: rejects invalid version", () => {
    const result = validateUpdaterManifest(
      { version: "not-semver", platforms: VALID_PLATFORMS },
      { checksums: VALID_CHECKSUMS },
    );
    expect(result.ok).toBe(false);
    expect(result.failures.some((f) => f.includes("not valid semver"))).toBe(
      true,
    );
  });

  test("error path: rejects downgrade metadata", () => {
    const result = validateUpdaterManifest(validManifest(), {
      checksums: VALID_CHECKSUMS,
      previousVersion: "0.3.0",
    });
    expect(result.ok).toBe(false);
    expect(result.failures.some((f) => f.includes("downgrade rejected"))).toBe(
      true,
    );
  });

  test("error path: rejects mismatched checksum file", () => {
    const result = validateUpdaterManifest(validManifest(), {
      checksums: new Map([
        ["mothership-aarch64-apple-darwin.app.tar.gz", "a".repeat(64)],
      ]),
    });
    expect(result.ok).toBe(false);
    expect(
      result.failures.some((f) =>
        f.includes(
          'No SHA256SUMS entry found for "mothership-x86_64-apple-darwin.app.tar.gz"',
        ),
      ),
    ).toBe(true);
  });
});

describe("parseArgs", () => {
  test("happy path: parses all flags", () => {
    expect(
      parseArgs([
        "--manifest",
        "latest.json",
        "--checksums",
        "SHA256SUMS",
        "--previous-version",
        "0.1.0",
      ]),
    ).toEqual({
      manifest: "latest.json",
      checksums: "SHA256SUMS",
      previousVersion: "0.1.0",
    });
  });

  test("edge case: missing flags are undefined", () => {
    const result = parseArgs([]);
    expect(result.manifest).toBeUndefined();
    expect(result.checksums).toBeUndefined();
    expect(result.previousVersion).toBeUndefined();
  });
});

test("ALLOWED_PLATFORMS is macOS-only", () => {
  expect(ALLOWED_PLATFORMS).toEqual(["darwin-aarch64", "darwin-x86_64"]);
});
