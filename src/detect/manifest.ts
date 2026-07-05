/**
 * Typed interface manifest for mechanical project detection.
 *
 * `DetectedInterface` is a discriminated union by `kind` — extensible so
 * more kinds can land without touching existing callers. Parse, don't
 * validate: detectors return these shapes directly, no separate validation
 * pass needed downstream.
 */

/** Storybook config source — which signal matched (dir presence wins over
 * package.json dependency scan). */
export type StorybookConfigSource = ".storybook" | "package.json";

export type DetectedInterface =
  | { kind: "opencode" }
  | { kind: "storybook"; config: StorybookConfigSource };

export interface ProjectManifest {
  projectName: string;
  projectPath: string;
  interfaces: DetectedInterface[];
}

export interface WorkspaceManifest {
  projects: ProjectManifest[];
}
