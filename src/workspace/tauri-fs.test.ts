/**
 * Verifies the tauri-fs seams call `invoke` with the right command name and
 * args, and that `loadWorkspace`/`buildBusContext` compose correctly when
 * wired with them (stubbing `@tauri-apps/api/core`'s `invoke`, which is the
 * actual Tauri boundary — no real IPC in tests).
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

const invokeMock = mock((_cmd: string, _args?: unknown): Promise<unknown> => {
  throw new Error("invokeMock not configured");
});

mock.module("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

describe("tauri-fs", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  test("readTextFile invokes read_text_file with the path", async () => {
    invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
      expect(cmd).toBe("read_text_file");
      expect(args).toEqual({ path: "/tmp/spacebus.json" });
      return "{}";
    });
    const { readTextFile } = await import("./tauri-fs");
    const result = await readTextFile("/tmp/spacebus.json");
    expect(result).toBe("{}");
  });

  test("pathExists invokes path_exists with the path", async () => {
    invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
      expect(cmd).toBe("path_exists");
      expect(args).toEqual({ path: "/tmp/proj" });
      return true;
    });
    const { pathExists } = await import("./tauri-fs");
    expect(await pathExists("/tmp/proj")).toBe(true);
  });

  test("homeDir invokes home_dir once and caches the result", async () => {
    let calls = 0;
    invokeMock.mockImplementation(async (cmd: string) => {
      expect(cmd).toBe("home_dir");
      calls++;
      return "/Users/marcus";
    });
    const tauriFs = await import("./tauri-fs");
    tauriFs.__resetHomeDirCacheForTests();
    expect(await tauriFs.homeDir()).toBe("/Users/marcus");
    expect(await tauriFs.homeDir()).toBe("/Users/marcus");
    expect(calls).toBe(1);
  });
});

describe("workspace wiring via tauri-fs seams", () => {
  test("loadWorkspace + buildBusContext compose with stubbed invoke", async () => {
    const manifest = {
      server: { baseUrl: "http://127.0.0.1:4096" },
      projects: [
        { name: "proj-a", path: "/abs/proj-a", description: "A project" },
      ],
    };
    invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "read_text_file") {
        expect(args).toEqual({ path: "/workspace/spacebus.json" });
        return JSON.stringify(manifest);
      }
      if (cmd === "path_exists") {
        expect(args).toEqual({ path: "/abs/proj-a" });
        return false;
      }
      throw new Error(`unexpected invoke: ${cmd}`);
    });

    const { readTextFile, pathExists } = await import("./tauri-fs");
    const { loadWorkspace } = await import("./config");
    const { buildBusContext } = await import("./context");

    const workspace = await loadWorkspace("/workspace", { readTextFile });
    expect(workspace.kind).toBe("workspace");

    const context = await buildBusContext(workspace, undefined, { pathExists });
    expect(context.roster.projects[0]).toMatchObject({
      name: "proj-a",
      exists: false,
    });
  });
});
