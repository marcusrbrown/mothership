#!/usr/bin/env bun
/**
 * Pure event/ref/tag eligibility helpers for the release pipeline.
 *
 * These helpers decide whether a workflow *context* is shaped like a
 * legitimate release trigger (protected version tag or maintainer manual
 * dispatch, tied to the repo's own mainline state). They intentionally do
 * NOT and cannot prove that CI passed for a given SHA — that is a separate,
 * network-backed required-check preflight (see scripts/verify-release-settings.ts
 * and the release workflow's own preflight job). Treat a `true` result here
 * as "not obviously disqualified," not as "safe to release."
 *
 * Usage: bun scripts/release-policy.ts --event <event> --ref <ref> [--repo owner/name] [--event-repo owner/name]
 */

const VERSION_TAG_PATTERN =
  /^refs\/tags\/v\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?(?:\+[0-9A-Za-z-.]+)?$/;

const MAIN_REF = "refs/heads/main";

/**
 * Event names that must never reach a secrets-bearing job. These carry
 * elevated privilege (`pull_request_target`), run in a different trust
 * context than the ref they report (`workflow_run`), are meant for reusable
 * callers rather than release triggers (`workflow_call`), or originate from
 * outside the maintainer's direct control (`pull_request`,
 * `repository_dispatch`).
 */
const DISALLOWED_EVENTS: ReadonlySet<string> = new Set([
  "pull_request_target",
  "workflow_run",
  "workflow_call",
  "pull_request",
  "repository_dispatch",
]);

/**
 * Event names that are structurally eligible to trigger a release, subject
 * to further ref/tag/repo checks.
 */
const ALLOWED_EVENTS: ReadonlySet<string> = new Set([
  "push",
  "workflow_dispatch",
]);

export type ReleaseContext = {
  /** GitHub Actions `github.event_name`. */
  eventName: string;
  /** GitHub Actions `github.ref`. */
  ref: string;
  /** `owner/repo` the workflow is running in (`github.repository`). */
  repository: string;
  /**
   * `owner/repo` the triggering event actually originated from, when it
   * differs from `repository` (e.g. a fork-originated event surfaced via
   * `pull_request` or `repository_dispatch`). Omit when there is no
   * meaningful distinction (same-repo push, manual dispatch).
   */
  eventRepository?: string;
};

export type ReleaseEligibility = {
  eligible: boolean;
  reasons: string[];
};

export function isVersionTagRef(ref: string): boolean {
  return VERSION_TAG_PATTERN.test(ref);
}

export function isMainRef(ref: string): boolean {
  return ref === MAIN_REF;
}

export function isDisallowedEvent(eventName: string): boolean {
  return DISALLOWED_EVENTS.has(eventName);
}

export function isFromFork(context: ReleaseContext): boolean {
  return (
    context.eventRepository !== undefined &&
    context.eventRepository !== context.repository
  );
}

/**
 * Evaluates whether a workflow context is shaped like a legitimate release
 * trigger. This is a pure, offline shape check: an eligible result means
 * "protected version tag, or manual dispatch on mainline, from this repo,
 * via an allowed event" — it does NOT verify that required CI checks have
 * passed for the relevant SHA. Callers must still run a required-check
 * preflight before any secrets-bearing job executes.
 */
export function evaluateReleaseEligibility(
  context: ReleaseContext,
): ReleaseEligibility {
  const reasons: string[] = [];

  if (isFromFork(context)) {
    reasons.push(
      `Event originated from "${context.eventRepository}", not the target repo "${context.repository}". Fork-originated events never receive release secrets.`,
    );
  }

  if (isDisallowedEvent(context.eventName)) {
    reasons.push(
      `Event "${context.eventName}" is never eligible to trigger a release (elevated-privilege, indirect-trust, reusable-caller, or externally-originated event type).`,
    );
  }

  if (!ALLOWED_EVENTS.has(context.eventName)) {
    reasons.push(
      `Event "${context.eventName}" is not one of the allowed release-trigger events (${[...ALLOWED_EVENTS].join(", ")}).`,
    );
  }

  const isTag = context.ref.startsWith("refs/tags/");
  if (isTag) {
    if (!isVersionTagRef(context.ref)) {
      reasons.push(
        `Ref "${context.ref}" is a tag but not a protected version tag (expected refs/tags/vX.Y.Z).`,
      );
    }
  } else if (!isMainRef(context.ref)) {
    reasons.push(
      `Ref "${context.ref}" is neither a protected version tag nor the mainline branch ("${MAIN_REF}").`,
    );
  } else if (context.eventName !== "workflow_dispatch") {
    // A plain push to main (not a version tag) is only eligible via an
    // explicit maintainer dispatch, never an automatic push trigger.
    reasons.push(
      `Ref "${context.ref}" is mainline but the event ("${context.eventName}") is not a maintainer-initiated manual dispatch.`,
    );
  }

  return { eligible: reasons.length === 0, reasons };
}

export function parseArgs(argv: string[]): {
  event?: string;
  ref?: string;
  repo?: string;
  eventRepo?: string;
} {
  const result: {
    event?: string;
    ref?: string;
    repo?: string;
    eventRepo?: string;
  } = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--event") {
      result.event = value;
      i += 1;
    } else if (flag === "--ref") {
      result.ref = value;
      i += 1;
    } else if (flag === "--repo") {
      result.repo = value;
      i += 1;
    } else if (flag === "--event-repo") {
      result.eventRepo = value;
      i += 1;
    }
  }
  return result;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!args.event || !args.ref || !args.repo) {
    console.error(
      "Usage: bun scripts/release-policy.ts --event <event> --ref <ref> --repo <owner/name> [--event-repo <owner/name>]",
    );
    process.exit(2);
  }

  const result = evaluateReleaseEligibility({
    eventName: args.event,
    ref: args.ref,
    repository: args.repo,
    eventRepository: args.eventRepo,
  });

  if (!result.eligible) {
    console.error("❌ Release context is not eligible:");
    for (const reason of result.reasons) {
      console.error(`  - ${reason}`);
    }
    console.error(
      "Note: this check only validates event/ref/tag shape. It does not prove required CI checks passed for this SHA.",
    );
    process.exit(1);
  }

  console.log("✅ Release context shape is eligible (event/ref/tag only).");
  console.log(
    "Note: a separate required-check preflight must still verify CI status before any secrets-bearing job runs.",
  );
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
