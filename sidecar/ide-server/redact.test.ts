import { describe, expect, test } from "bun:test";
import { redactForRead } from "./redact";

describe("redactForRead", () => {
  test("redacts absolute unix paths to basenames", () => {
    const input = { directory: "/Users/marcus/src/project-alpha" };
    expect(redactForRead(input)).toEqual({ directory: "project-alpha" });
  });

  test("leaves non-path strings untouched", () => {
    const input = { title: "Sessions", panelType: "sessions" };
    expect(redactForRead(input)).toEqual(input);
  });

  test("recurses into nested objects and arrays", () => {
    const input = {
      panels: {
        p1: { params: { directory: "/home/user/repo-x" } },
      },
      list: ["/a/b/c", "plain"],
    };
    expect(redactForRead(input)).toEqual({
      panels: { p1: { params: { directory: "repo-x" } } },
      list: ["c", "plain"],
    });
  });

  test("drops known live-handle keys defensively", () => {
    const input = { store: {}, client: {}, title: "x" };
    expect(redactForRead(input)).toEqual({ title: "x" });
  });
});
