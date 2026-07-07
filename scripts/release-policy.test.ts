import { describe, expect, test } from "bun:test";
import {
  type ReleaseContext,
  evaluateReleaseEligibility,
  isDisallowedEvent,
  isFromFork,
  isMainRef,
  isVersionTagRef,
  parseArgs,
} from "./release-policy";

const REPO = "marcusrbrown/mothership";

function context(overrides: Partial<ReleaseContext> = {}): ReleaseContext {
  return {
    eventName: "push",
    ref: "refs/tags/v0.2.0",
    repository: REPO,
    ...overrides,
  };
}

describe("isVersionTagRef", () => {
  test("happy path: accepts a plain version tag", () => {
    expect(isVersionTagRef("refs/tags/v0.2.0")).toBe(true);
  });

  test("edge case: accepts prerelease and build metadata tags", () => {
    expect(isVersionTagRef("refs/tags/v0.2.0-rc.1")).toBe(true);
    expect(isVersionTagRef("refs/tags/v0.2.0+build.3")).toBe(true);
  });

  test("error path: rejects non-version tags", () => {
    expect(isVersionTagRef("refs/tags/latest")).toBe(false);
    expect(isVersionTagRef("refs/tags/0.2.0")).toBe(false);
    expect(isVersionTagRef("refs/heads/main")).toBe(false);
  });
});

describe("isMainRef", () => {
  test("happy path: recognizes the main branch ref", () => {
    expect(isMainRef("refs/heads/main")).toBe(true);
  });

  test("error path: rejects other branch refs", () => {
    expect(isMainRef("refs/heads/develop")).toBe(false);
    expect(isMainRef("refs/tags/v0.2.0")).toBe(false);
  });
});

describe("isDisallowedEvent", () => {
  test("error path: flags elevated-privilege and indirect-trust events", () => {
    expect(isDisallowedEvent("pull_request_target")).toBe(true);
    expect(isDisallowedEvent("workflow_run")).toBe(true);
    expect(isDisallowedEvent("workflow_call")).toBe(true);
    expect(isDisallowedEvent("pull_request")).toBe(true);
    expect(isDisallowedEvent("repository_dispatch")).toBe(true);
  });

  test("happy path: allows push and workflow_dispatch", () => {
    expect(isDisallowedEvent("push")).toBe(false);
    expect(isDisallowedEvent("workflow_dispatch")).toBe(false);
  });
});

describe("isFromFork", () => {
  test("happy path: same repo is not a fork", () => {
    expect(isFromFork(context({ eventRepository: REPO }))).toBe(false);
  });

  test("edge case: no eventRepository means no fork signal", () => {
    expect(isFromFork(context())).toBe(false);
  });

  test("error path: mismatched eventRepository is a fork", () => {
    expect(
      isFromFork(context({ eventRepository: "someone-else/mothership" })),
    ).toBe(true);
  });
});

describe("evaluateReleaseEligibility", () => {
  test("happy path: accepts a protected version tag push", () => {
    const result = evaluateReleaseEligibility(
      context({ eventName: "push", ref: "refs/tags/v0.2.0" }),
    );
    expect(result.eligible).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  test("happy path: accepts manual dispatch tied to mainline", () => {
    const result = evaluateReleaseEligibility(
      context({ eventName: "workflow_dispatch", ref: "refs/heads/main" }),
    );
    expect(result.eligible).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  test("edge case: rejects non-version tags", () => {
    const result = evaluateReleaseEligibility(
      context({ eventName: "push", ref: "refs/tags/latest" }),
    );
    expect(result.eligible).toBe(false);
    expect(
      result.reasons.some((r) => r.includes("protected version tag")),
    ).toBe(true);
  });

  test("edge case: rejects non-main, non-tag refs", () => {
    const result = evaluateReleaseEligibility(
      context({ eventName: "workflow_dispatch", ref: "refs/heads/feature/x" }),
    );
    expect(result.eligible).toBe(false);
    expect(
      result.reasons.some((r) => r.includes("neither a protected version tag")),
    ).toBe(true);
  });

  test("edge case: rejects an automatic push to main (not a version tag)", () => {
    const result = evaluateReleaseEligibility(
      context({ eventName: "push", ref: "refs/heads/main" }),
    );
    expect(result.eligible).toBe(false);
    expect(
      result.reasons.some((r) =>
        r.includes("maintainer-initiated manual dispatch"),
      ),
    ).toBe(true);
  });

  test("error path: rejects pull_request_target before any other check matters", () => {
    const result = evaluateReleaseEligibility(
      context({ eventName: "pull_request_target", ref: "refs/tags/v0.2.0" }),
    );
    expect(result.eligible).toBe(false);
    expect(
      result.reasons.some((r) => r.includes('Event "pull_request_target"')),
    ).toBe(true);
  });

  test("error path: rejects workflow_run contexts", () => {
    const result = evaluateReleaseEligibility(
      context({ eventName: "workflow_run", ref: "refs/tags/v0.2.0" }),
    );
    expect(result.eligible).toBe(false);
  });

  test("error path: rejects workflow_call contexts", () => {
    const result = evaluateReleaseEligibility(
      context({ eventName: "workflow_call", ref: "refs/tags/v0.2.0" }),
    );
    expect(result.eligible).toBe(false);
  });

  test("error path: rejects PR-triggered contexts regardless of ref", () => {
    const result = evaluateReleaseEligibility(
      context({ eventName: "pull_request", ref: "refs/heads/main" }),
    );
    expect(result.eligible).toBe(false);
  });

  test("error path: rejects fork-originated events even on a version tag", () => {
    const result = evaluateReleaseEligibility(
      context({
        eventName: "push",
        ref: "refs/tags/v0.2.0",
        eventRepository: "someone-else/mothership",
      }),
    );
    expect(result.eligible).toBe(false);
    expect(result.reasons.some((r) => r.includes("Fork-originated"))).toBe(
      true,
    );
  });

  test("error path: rejects repository_dispatch-style contexts", () => {
    const result = evaluateReleaseEligibility(
      context({ eventName: "repository_dispatch", ref: "refs/tags/v0.2.0" }),
    );
    expect(result.eligible).toBe(false);
  });
});

describe("parseArgs", () => {
  test("happy path: parses all flags", () => {
    const result = parseArgs([
      "--event",
      "push",
      "--ref",
      "refs/tags/v0.2.0",
      "--repo",
      REPO,
      "--event-repo",
      REPO,
    ]);
    expect(result).toEqual({
      event: "push",
      ref: "refs/tags/v0.2.0",
      repo: REPO,
      eventRepo: REPO,
    });
  });

  test("edge case: missing flags are undefined", () => {
    const result = parseArgs([]);
    expect(result.event).toBeUndefined();
    expect(result.ref).toBeUndefined();
    expect(result.repo).toBeUndefined();
    expect(result.eventRepo).toBeUndefined();
  });
});
