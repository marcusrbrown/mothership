import { describe, expect, test } from "bun:test";
import { decideEnterAction } from "./keymap";

describe("decideEnterAction", () => {
  test("bare Enter submits", () => {
    expect(decideEnterAction({ key: "Enter", shiftKey: false })).toBe("submit");
  });

  test("Shift+Enter newlines", () => {
    expect(decideEnterAction({ key: "Enter", shiftKey: true })).toBe("newline");
  });

  test("Mod+Enter (meta) newlines, matching the plain bar's bare-Enter-submits contract", () => {
    expect(
      decideEnterAction({ key: "Enter", shiftKey: false, metaKey: true }),
    ).toBe("newline");
  });

  test("Ctrl+Enter newlines", () => {
    expect(
      decideEnterAction({ key: "Enter", shiftKey: false, ctrlKey: true }),
    ).toBe("newline");
  });

  test("non-Enter key is ignored", () => {
    expect(decideEnterAction({ key: "a", shiftKey: false })).toBe("ignore");
  });
});
