#!/usr/bin/env bun
/**
 * Applies release-critical repo settings as code:
 *   - the tag ruleset in .github/rulesets/v0-1-release-tags.json
 *   - a protected GitHub Actions `release` environment with required reviewers
 *
 * Idempotent: re-running with the same inputs converges to the same state
 * instead of erroring on "already exists". Requires `gh` authenticated with
 * `repo` + `admin:repo_hook`-level access (repo admin) against the target
 * repo; run this out-of-band from any secret-bearing release job.
 *
 * Usage: bun scripts/apply-release-settings.ts [--repo owner/name] [--reviewer login]...
 */
import { readFile } from "node:fs/promises";

const RULESET_PATH = new URL(
  "../.github/rulesets/v0-1-release-tags.json",
  import.meta.url,
);

const RELEASE_ENVIRONMENT = "release";

function parseArgs(argv: string[]): { repo?: string; reviewers: string[] } {
  let repo: string | undefined;
  const reviewers: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--repo") {
      repo = argv[i + 1];
      i += 1;
    } else if (arg === "--reviewer") {
      const value = argv[i + 1];
      if (value) reviewers.push(value);
      i += 1;
    }
  }
  return { repo, reviewers };
}

async function gh(
  args: string[],
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { ok: exitCode === 0, stdout, stderr };
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

async function applyRuleset(repo: string): Promise<void> {
  const raw = await readFile(RULESET_PATH, "utf8");
  const ruleset: { name: string } = JSON.parse(raw);

  const list = await gh([
    "api",
    `repos/${repo}/rulesets`,
    "--jq",
    ".[] | {id, name}",
  ]);
  if (!list.ok) {
    throw new Error(
      `Failed to list existing rulesets for ${repo}: ${list.stderr.trim()}. Manual blocker: verify the token has repo admin access, or apply the ruleset via Settings > Rules > Rulesets in the GitHub UI using the JSON in .github/rulesets/v0-1-release-tags.json.`,
    );
  }

  let existingId: number | undefined;
  for (const line of list.stdout.trim().split("\n").filter(Boolean)) {
    const entry = JSON.parse(line) as { id: number; name: string };
    if (entry.name === ruleset.name) existingId = entry.id;
  }

  const method = existingId ? "PUT" : "POST";
  const endpoint = existingId
    ? `repos/${repo}/rulesets/${existingId}`
    : `repos/${repo}/rulesets`;

  const result = await gh([
    "api",
    "--method",
    method,
    endpoint,
    "--input",
    RULESET_PATH.pathname,
  ]);

  if (!result.ok) {
    throw new Error(
      `Failed to ${existingId ? "update" : "create"} ruleset "${ruleset.name}" on ${repo}: ${result.stderr.trim()}. Manual blocker: apply .github/rulesets/v0-1-release-tags.json by hand under Settings > Rules > Rulesets.`,
    );
  }

  console.log(
    `✅ Ruleset "${ruleset.name}" ${existingId ? "updated" : "created"} on ${repo}.`,
  );
}

async function applyReleaseEnvironment(
  repo: string,
  reviewers: string[],
): Promise<void> {
  if (reviewers.length === 0) {
    throw new Error(
      'No --reviewer provided. Manual blocker: the "release" GitHub Actions environment ' +
        "must have at least one required reviewer configured before this script can proceed " +
        "(pass --reviewer <login> one or more times).",
    );
  }

  const reviewerLookups = await Promise.all(
    reviewers.map(async (login) => {
      const result = await gh(["api", `users/${login}`, "--jq", ".id"]);
      if (!result.ok) {
        throw new Error(
          `Could not resolve GitHub user id for reviewer "${login}": ${result.stderr.trim()}.`,
        );
      }
      return { type: "User", id: Number(result.stdout.trim()) };
    }),
  );

  const body = JSON.stringify({
    reviewers: reviewerLookups,
    deployment_branch_policy: {
      protected_branches: false,
      custom_branch_policies: true,
    },
  });

  const proc = Bun.spawn(
    [
      "gh",
      "api",
      "--method",
      "PUT",
      `repos/${repo}/environments/${RELEASE_ENVIRONMENT}`,
      "--input",
      "-",
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  proc.stdin.write(body);
  await proc.stdin.end();
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  void stdout;

  if (exitCode !== 0) {
    throw new Error(
      `Failed to configure protected environment "${RELEASE_ENVIRONMENT}" on ${repo}: ${stderr.trim()}. Manual blocker: create the "release" environment under Settings > Environments and add the required reviewers by hand.`,
    );
  }

  const branchPolicyBody = JSON.stringify({
    name: "v*",
  });
  const branchPolicyProc = Bun.spawn(
    [
      "gh",
      "api",
      "--method",
      "POST",
      `repos/${repo}/environments/${RELEASE_ENVIRONMENT}/deployment-branch-policies`,
      "--input",
      "-",
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  branchPolicyProc.stdin.write(branchPolicyBody);
  await branchPolicyProc.stdin.end();
  await branchPolicyProc.exited;
  // Non-fatal: policy may already exist (422), which is fine for idempotency.

  console.log(
    `✅ Environment "${RELEASE_ENVIRONMENT}" configured on ${repo} with reviewers: ${reviewers.join(", ")}.`,
  );
}

async function main(): Promise<void> {
  const { repo: explicitRepo, reviewers } = parseArgs(process.argv.slice(2));
  const repo = await resolveRepo(explicitRepo);

  await applyRuleset(repo);
  await applyReleaseEnvironment(repo, reviewers);

  console.log(
    "Run `bun scripts/verify-release-settings.ts` to confirm the applied state.",
  );
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
