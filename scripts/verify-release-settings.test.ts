import { describe, expect, test } from "bun:test";
import {
  checkReleaseEnvironmentShape,
  checkRulesetShape,
} from "./verify-release-settings";

const declaredRuleset = {
  name: "v0-1-release-tags",
  target: "tag",
  enforcement: "active",
  rules: [
    { type: "deletion" },
    { type: "non_fast_forward" },
    {
      type: "required_status_checks",
      parameters: {
        required_status_checks: [
          { context: "Design Check" },
          { context: "verify (typecheck)" },
          { context: "Release Config Smoke" },
        ],
      },
    },
  ],
};

describe("checkRulesetShape", () => {
  test("happy path: accepts a remote ruleset matching the declared shape", () => {
    const remote = {
      id: 1,
      name: "v0-1-release-tags",
      target: "tag",
      enforcement: "active",
      rules: declaredRuleset.rules,
    };
    expect(checkRulesetShape(declaredRuleset, remote)).toEqual([]);
  });

  test("edge case: missing remote ruleset is blocking, not warning-only", () => {
    const failures = checkRulesetShape(declaredRuleset, undefined);
    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0]).toContain("No ruleset named");
  });

  test("error path: unprotected tags (missing deletion/non_fast_forward rules) fail", () => {
    const remote = {
      id: 1,
      name: "v0-1-release-tags",
      target: "tag",
      enforcement: "active",
      rules: [
        {
          type: "required_status_checks",
          parameters: {
            required_status_checks: [
              { context: "Design Check" },
              { context: "verify (typecheck)" },
            ],
          },
        },
      ],
    };
    const failures = checkRulesetShape(declaredRuleset, remote);
    expect(failures.some((f) => f.includes("block tag deletion"))).toBe(true);
    expect(failures.some((f) => f.includes("non-fast-forward"))).toBe(true);
  });

  test("error path: missing a required status check fails", () => {
    const remote = {
      id: 1,
      name: "v0-1-release-tags",
      target: "tag",
      enforcement: "active",
      rules: [
        { type: "deletion" },
        { type: "non_fast_forward" },
        {
          type: "required_status_checks",
          parameters: { required_status_checks: [{ context: "Design Check" }] },
        },
      ],
    };
    const failures = checkRulesetShape(declaredRuleset, remote);
    expect(failures.some((f) => f.includes('"verify (typecheck)"'))).toBe(true);
  });

  test("error path: wrong target or enforcement fails", () => {
    const remote = {
      id: 1,
      name: "v0-1-release-tags",
      target: "branch",
      enforcement: "disabled",
      rules: declaredRuleset.rules,
    };
    const failures = checkRulesetShape(declaredRuleset, remote);
    expect(failures.some((f) => f.includes("target"))).toBe(true);
    expect(failures.some((f) => f.includes("enforcement"))).toBe(true);
  });
});

describe("checkReleaseEnvironmentShape", () => {
  test("happy path: accepts a protected environment with a required reviewer", () => {
    const remote = {
      name: "release",
      protection_rules: [
        { type: "required_reviewers", reviewers: [{ id: 1 }] },
      ],
    };
    expect(checkReleaseEnvironmentShape("release", remote)).toEqual([]);
  });

  test("edge case: missing/unreadable environment is blocking", () => {
    const failures = checkReleaseEnvironmentShape("release", undefined);
    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0]).toContain("No GitHub Actions environment");
  });

  test("error path: environment with zero required reviewers fails", () => {
    const remote = {
      name: "release",
      protection_rules: [{ type: "required_reviewers", reviewers: [] }],
    };
    const failures = checkReleaseEnvironmentShape("release", remote);
    expect(failures.some((f) => f.includes("no required reviewers"))).toBe(
      true,
    );
  });

  test("error path: environment with no protection_rules at all fails", () => {
    const remote = { name: "release" };
    const failures = checkReleaseEnvironmentShape("release", remote);
    expect(failures.some((f) => f.includes("no required reviewers"))).toBe(
      true,
    );
  });
});
