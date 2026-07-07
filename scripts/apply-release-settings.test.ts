import { describe, expect, test } from "bun:test";
import { USAGE, parseArgs } from "./apply-release-settings";

describe("parseArgs", () => {
  test("happy path: parses repo and multiple reviewers", () => {
    const result = parseArgs([
      "--repo",
      "marcusrbrown/mothership",
      "--reviewer",
      "alice",
      "--reviewer",
      "bob",
    ]);
    expect(result).toEqual({
      repo: "marcusrbrown/mothership",
      reviewers: ["alice", "bob"],
      help: false,
    });
  });

  test("edge case: no reviewers is an empty array, not undefined", () => {
    const result = parseArgs(["--repo", "owner/name"]);
    expect(result.reviewers).toEqual([]);
    expect(result.help).toBe(false);
  });

  test("edge case: --help and -h both set help", () => {
    expect(parseArgs(["--help"]).help).toBe(true);
    expect(parseArgs(["-h"]).help).toBe(true);
  });

  test("edge case: --help short-circuits without requiring other args", () => {
    const result = parseArgs(["--help"]);
    expect(result.repo).toBeUndefined();
    expect(result.reviewers).toEqual([]);
  });
});

describe("USAGE", () => {
  test("documents --reviewer as a GitHub user login", () => {
    expect(USAGE).toContain("GitHub user login");
    expect(USAGE).toContain("--reviewer");
    expect(USAGE).toContain("--help");
  });
});
