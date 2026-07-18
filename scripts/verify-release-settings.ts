#!/usr/bin/env bun
/**
 * Verifies that release-critical repo settings match what's declared in
 * .github/rulesets/v0-1-release-tags.json and the protected `release`
 * GitHub Actions environment. Fails closed: any setting that can't be
 * read, or doesn't match, is a blocking failure — never a warning.
 *
 * Intended to run as a preflight step before the release workflow requests
 * the protected `release` environment (see .github/workflows/release.yaml).
 *
 * Usage: bun scripts/verify-release-settings.ts [--repo owner/name]
 */
import { readFile } from "node:fs/promises";

const RULESET_PATH = new URL(
  "../.github/rulesets/v0-1-release-tags.json",
  import.meta.url,
);

const RELEASE_ENVIRONMENT = "release";

export type VerifyResult = {
  ok: boolean;
  failures: string[];
};

type RulesetRule = { type: string; parameters?: Record<string, unknown> };

type DeclaredRuleset = {
  name: string;
  target: string;
  enforcement: string;
  rules: RulesetRule[];
};

type RemoteRuleset = {
  id: number;
  name: string;
  target?: string;
  enforcement?: string;
  rules?: RulesetRule[];
};

type RemoteEnvironment = {
  name?: string;
  protection_rules?: Array<{ type: string; reviewers?: unknown[] }>;
};

export function parseArgs(argv: string[]): { repo?: string } {
  let repo: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--repo") {
      repo = argv[i + 1];
      i += 1;
    }
  }
  return { repo };
}

function requiredStatusContexts(rules: RulesetRule[]): string[] {
  const rule = rules.find((r) => r.type === "required_status_checks");
  if (!rule?.parameters) return [];
  const checks = rule.parameters.required_status_checks;
  if (!Array.isArray(checks)) return [];
  return checks
    .map((c) => {
      if (typeof c !== "object" || !c || !("context" in c)) return undefined;
      const context = (c as { context: unknown }).context;
      return typeof context === "string" ? context : undefined;
    })
    .filter((c): c is string => typeof c === "string");
}

function hasRuleType(rules: RulesetRule[], type: string): boolean {
  return rules.some((r) => r.type === type);
}

/**
 * Compares a declared ruleset (source of truth in the repo) against the
 * remote ruleset returned by the GitHub API. Pure function — no network —
 * so it's directly unit-testable.
 */
export function checkRulesetShape(
  declared: DeclaredRuleset,
  remote: RemoteRuleset | undefined,
): string[] {
  const failures: string[] = [];

  if (!remote) {
    failures.push(
      `No ruleset named "${declared.name}" found on the repo (unreadable or missing).`,
    );
    return failures;
  }

  if (remote.target !== declared.target) {
    failures.push(
      `Ruleset "${declared.name}" target is "${remote.target}", expected "${declared.target}".`,
    );
  }

  if (remote.enforcement !== declared.enforcement) {
    failures.push(
      `Ruleset "${declared.name}" enforcement is "${remote.enforcement}", expected "${declared.enforcement}" (active).`,
    );
  }

  const remoteRules = remote.rules ?? [];

  if (!hasRuleType(remoteRules, "deletion")) {
    failures.push(`Ruleset "${declared.name}" does not block tag deletion.`);
  }
  if (!hasRuleType(remoteRules, "non_fast_forward")) {
    failures.push(
      `Ruleset "${declared.name}" does not block non-fast-forward tag updates.`,
    );
  }

  const declaredChecks = new Set(requiredStatusContexts(declared.rules));
  const remoteChecks = new Set(requiredStatusContexts(remoteRules));
  for (const check of declaredChecks) {
    if (!remoteChecks.has(check)) {
      failures.push(
        `Ruleset "${declared.name}" is missing required status check "${check}".`,
      );
    }
  }

  return failures;
}

/**
 * Verifies the protected `release` environment has at least one required
 * reviewer configured. Pure function — no network.
 */
export function checkReleaseEnvironmentShape(
  environmentName: string,
  remote: RemoteEnvironment | undefined,
): string[] {
  const failures: string[] = [];

  if (!remote) {
    failures.push(
      `No GitHub Actions environment named "${environmentName}" found (unreadable or missing).`,
    );
    return failures;
  }

  const reviewRule = remote.protection_rules?.find(
    (r) => r.type === "required_reviewers",
  );
  const reviewerCount = reviewRule?.reviewers?.length ?? 0;

  if (reviewerCount < 1) {
    failures.push(
      `Environment "${environmentName}" has no required reviewers configured. Release cannot be gated without at least one required reviewer.`,
    );
  }

  return failures;
}

const GH_TIMEOUT_MS = 30_000;

async function gh(
  args: string[],
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
  const timeout = setTimeout(() => {
    proc.kill();
  }, GH_TIMEOUT_MS);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { ok: exitCode === 0, stdout, stderr };
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveRepo(explicit: string | undefined): Promise<string> {
  if (explicit) return explicit;
  const result = await gh([
    "repo",
    "view",
    "--json",
    "nameWithOwner",
    "-q",
    ".nameWithOwner",
  ]);
  if (!result.ok) {
    throw new Error(
      `Could not resolve target repo from \`gh repo view\` (${result.stderr.trim()}). Pass --repo owner/name explicitly.`,
    );
  }
  return result.stdout.trim();
}

async function fetchRemoteRuleset(
  repo: string,
  name: string,
): Promise<RemoteRuleset | undefined> {
  const list = await gh([
    "api",
    `repos/${repo}/rulesets`,
    "--jq",
    ".[] | {id, name}",
  ]);
  if (!list.ok) {
    throw new Error(
      `Could not list rulesets for ${repo}: ${list.stderr.trim()}`,
    );
  }
  let id: number | undefined;
  for (const line of list.stdout.trim().split("\n").filter(Boolean)) {
    const entry = JSON.parse(line) as { id: number; name: string };
    if (entry.name === name) id = entry.id;
  }
  if (id === undefined) return undefined;

  const detail = await gh(["api", `repos/${repo}/rulesets/${id}`]);
  if (!detail.ok) {
    throw new Error(
      `Could not read ruleset ${id} on ${repo}: ${detail.stderr.trim()}`,
    );
  }
  return JSON.parse(detail.stdout) as RemoteRuleset;
}

async function fetchRemoteEnvironment(
  repo: string,
  name: string,
): Promise<RemoteEnvironment | undefined> {
  const result = await gh(["api", `repos/${repo}/environments/${name}`]);
  if (!result.ok) {
    if (result.stderr.includes("404") || result.stderr.includes("Not Found")) {
      return undefined;
    }
    throw new Error(
      `Could not read environment "${name}" on ${repo}: ${result.stderr.trim()}`,
    );
  }
  return JSON.parse(result.stdout) as RemoteEnvironment;
}

export async function verify(repo: string): Promise<VerifyResult> {
  const raw = await readFile(RULESET_PATH, "utf8");
  const declared = JSON.parse(raw) as DeclaredRuleset;

  const [remoteRuleset, remoteEnvironment] = await Promise.all([
    fetchRemoteRuleset(repo, declared.name).catch((error: unknown) => {
      throw new Error(
        `Ruleset check failed closed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }),
    fetchRemoteEnvironment(repo, RELEASE_ENVIRONMENT).catch(
      (error: unknown) => {
        throw new Error(
          `Environment check failed closed: ${error instanceof Error ? error.message : String(error)}`,
        );
      },
    ),
  ]);

  const failures = [
    ...checkRulesetShape(declared, remoteRuleset),
    ...checkReleaseEnvironmentShape(RELEASE_ENVIRONMENT, remoteEnvironment),
  ];

  return { ok: failures.length === 0, failures };
}

async function main(): Promise<void> {
  const { repo: explicitRepo } = parseArgs(process.argv.slice(2));
  const repo = await resolveRepo(explicitRepo);

  const result = await verify(repo);

  if (!result.ok) {
    console.error("❌ Release settings verification FAILED:");
    for (const failure of result.failures) {
      console.error(`  - ${failure}`);
    }
    process.exit(1);
  }

  console.log(`✅ Release settings verified for ${repo}.`);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
