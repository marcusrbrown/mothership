import { describe, expect, test } from "bun:test";
import type { ConfigEnv } from "vite";
import viteConfig from "./vite.config";

const testConfigEnv: ConfigEnv = {
  command: "serve",
  mode: "test",
};

describe("vite.config.ts env exposure", () => {
  test("envPrefix is restricted to VITE_ and never widened to expose TAURI_*", async () => {
    const resolved =
      typeof viteConfig === "function"
        ? await viteConfig(testConfigEnv)
        : viteConfig;
    const config = "then" in resolved ? await resolved : resolved;
    expect(config.envPrefix).toBe("VITE_");
  });
});
