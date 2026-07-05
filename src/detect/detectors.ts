/**
 * Mechanical detectors: filesystem existence/read only via injected
 * seams — no LLM, no network calls (AGENTS.md invariant). Detectors are a
 * pluggable registry (`defaultDetectors`) so more kinds can be added
 * without touching this module's callers.
 */
import type { Project } from "../workspace/config";
import {
  pathExists as tauriPathExists,
  readTextFile as tauriReadTextFile,
} from "../workspace/tauri-fs";
import type {
  DetectedInterface,
  ProjectManifest,
  WorkspaceManifest,
} from "./manifest";

/** Injected filesystem seam — defaults to the real Tauri-backed
 * implementations; tests stub both functions directly. */
export interface DetectorFs {
  pathExists: (path: string) => Promise<boolean>;
  readTextFile: (path: string) => Promise<string>;
}

export const defaultDetectorFs: DetectorFs = {
  pathExists: tauriPathExists,
  readTextFile: tauriReadTextFile,
};

/** A mechanical detector: given a project's expanded path and the injected
 * fs seam, resolves to a detected interface or `null`. Never throws — I/O
 * failures (missing file, malformed JSON) resolve to `null`. */
export type Detector = (
  project: Project,
  fs: DetectorFs,
) => Promise<DetectedInterface | null>;

/** Joins a directory and a relative segment with a single `/`, tolerant of
 * a trailing slash on `dir` (expandedPath may or may not have one). */
function join(dir: string, segment: string): string {
  return `${dir.replace(/\/+$/, "")}/${segment}`;
}

const STORYBOOK_DEP_PATTERN = /^(@storybook\/|storybook$)/;

export const opencodeDetector: Detector = async (project, fs) => {
  const exists = await fs.pathExists(join(project.expandedPath, ".opencode"));
  return exists ? { kind: "opencode" } : null;
};

export const storybookDetector: Detector = async (project, fs) => {
  const hasConfigDir = await fs.pathExists(
    join(project.expandedPath, ".storybook"),
  );
  if (hasConfigDir) {
    return { kind: "storybook", config: ".storybook" };
  }

  let raw: string;
  try {
    raw = await fs.readTextFile(join(project.expandedPath, "package.json"));
  } catch {
    return null;
  }

  let pkg: unknown;
  try {
    pkg = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof pkg !== "object" || pkg === null) return null;
  const record = pkg as Record<string, unknown>;
  const depSections = [record.dependencies, record.devDependencies];
  for (const section of depSections) {
    if (typeof section !== "object" || section === null) continue;
    const keys = Object.keys(section as Record<string, unknown>);
    if (keys.some((k) => STORYBOOK_DEP_PATTERN.test(k))) {
      return { kind: "storybook", config: "package.json" };
    }
  }
  return null;
};

/** Registry of mechanical detectors run per project (pluggable
 * detection); more kinds get appended here. */
export const defaultDetectors: Detector[] = [
  opencodeDetector,
  storybookDetector,
];

/** Runs every detector against a project, collecting non-null matches. A
 * project with zero matches still yields a `ProjectManifest` with
 * `interfaces: []` — the universal-panels baseline. */
export async function detectProject(
  project: Project,
  fs: DetectorFs = defaultDetectorFs,
  detectors: Detector[] = defaultDetectors,
): Promise<ProjectManifest> {
  const results = await Promise.all(detectors.map((d) => d(project, fs)));
  const interfaces = results.filter((r): r is DetectedInterface => r !== null);
  return {
    projectName: project.name,
    projectPath: project.expandedPath,
    interfaces,
  };
}

/** Detects interfaces for every project in the workspace roster. */
export async function detectWorkspace(
  projects: Project[],
  fs: DetectorFs = defaultDetectorFs,
  detectors: Detector[] = defaultDetectors,
): Promise<WorkspaceManifest> {
  const manifestProjects = await Promise.all(
    projects.map((p) => detectProject(p, fs, detectors)),
  );
  return { projects: manifestProjects };
}
