import { describe, expect, test } from "bun:test";
import type { Project } from "../workspace/config";
import {
  type DetectorFs,
  detectProject,
  detectWorkspace,
  opencodeDetector,
  storybookDetector,
} from "./detectors";
import type { DetectedInterface } from "./manifest";

function project(name: string, expandedPath = `/repo/${name}`): Project {
  return { name, path: expandedPath, description: "", expandedPath };
}

function fs(overrides: Partial<DetectorFs>): DetectorFs {
  return {
    pathExists: async () => false,
    readTextFile: async () => {
      throw new Error("ENOENT");
    },
    ...overrides,
  };
}

describe("opencodeDetector", () => {
  test(".opencode present → {kind: 'opencode'}", async () => {
    const p = project("a");
    const result = await opencodeDetector(
      p,
      fs({
        pathExists: async (path) => path === `${p.expandedPath}/.opencode`,
      }),
    );
    expect(result).toEqual({ kind: "opencode" });
  });

  test(".opencode absent → null", async () => {
    const p = project("a");
    const result = await opencodeDetector(p, fs({}));
    expect(result).toBeNull();
  });
});

describe("storybookDetector", () => {
  test(".storybook dir present → {kind: 'storybook', config: '.storybook'}", async () => {
    const p = project("a");
    const result = await storybookDetector(
      p,
      fs({
        pathExists: async (path) => path === `${p.expandedPath}/.storybook`,
      }),
    );
    expect(result).toEqual({ kind: "storybook", config: ".storybook" });
  });

  test("no dir, package.json has @storybook/react dep → config: 'package.json'", async () => {
    const p = project("a");
    const result = await storybookDetector(
      p,
      fs({
        readTextFile: async (path) => {
          if (path === `${p.expandedPath}/package.json`) {
            return JSON.stringify({
              devDependencies: { "@storybook/react": "^8.0.0" },
            });
          }
          throw new Error("ENOENT");
        },
      }),
    );
    expect(result).toEqual({ kind: "storybook", config: "package.json" });
  });

  test("plain 'storybook' dependency also matches", async () => {
    const p = project("a");
    const result = await storybookDetector(
      p,
      fs({
        readTextFile: async () =>
          JSON.stringify({ dependencies: { storybook: "^8.0.0" } }),
      }),
    );
    expect(result).toEqual({ kind: "storybook", config: "package.json" });
  });

  test("no dir, package.json without storybook → null", async () => {
    const p = project("a");
    const result = await storybookDetector(
      p,
      fs({
        readTextFile: async () =>
          JSON.stringify({ dependencies: { react: "^18.0.0" } }),
      }),
    );
    expect(result).toBeNull();
  });

  test("malformed package.json → null (no throw)", async () => {
    const p = project("a");
    const result = await storybookDetector(
      p,
      fs({ readTextFile: async () => "{ not valid json" }),
    );
    expect(result).toBeNull();
  });

  test("missing package.json → null", async () => {
    const p = project("a");
    const result = await storybookDetector(p, fs({}));
    expect(result).toBeNull();
  });
});

describe("detectProject", () => {
  test("collects multiple interfaces", async () => {
    const p = project("a");
    const manifest = await detectProject(
      p,
      fs({
        pathExists: async (path) =>
          path === `${p.expandedPath}/.opencode` ||
          path === `${p.expandedPath}/.storybook`,
      }),
    );
    expect(manifest.projectName).toBe("a");
    expect(manifest.projectPath).toBe(p.expandedPath);
    const kinds = manifest.interfaces.map((i) => i.kind).sort();
    expect(kinds).toEqual(["opencode", "storybook"]);
  });

  test("zero matches → empty interfaces array", async () => {
    const p = project("a");
    const manifest = await detectProject(p, fs({}));
    expect(manifest.interfaces).toEqual([]);
  });
});

describe("detectWorkspace", () => {
  test("mix of detected and undetected projects", async () => {
    const detected = project("detected");
    const undetected = project("undetected");
    const manifest = await detectWorkspace(
      [detected, undetected],
      fs({
        pathExists: async (path) =>
          path === `${detected.expandedPath}/.opencode`,
      }),
    );
    expect(manifest.projects).toHaveLength(2);
    expect(manifest.projects[0]?.interfaces).toEqual([{ kind: "opencode" }]);
    expect(manifest.projects[1]?.interfaces).toEqual([]);
  });
});

describe("manifest typing", () => {
  test("discriminated union narrows by kind", () => {
    const iface: DetectedInterface = {
      kind: "storybook",
      config: "package.json",
    };
    if (iface.kind === "storybook") {
      // `config` is only accessible after narrowing — this is a compile-time
      // assertion; runtime check just confirms the shape survived.
      expect(iface.config).toBe("package.json");
    } else {
      throw new Error("expected storybook kind");
    }
  });
});
