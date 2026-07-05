import { afterEach, describe, expect, test } from "bun:test";
import {
  __resetRegistryForTests,
  isMcpOpenable,
  registerPanelType,
} from "./registry";

function stubComponent() {
  return (() => null) as unknown as Parameters<
    typeof registerPanelType
  >[1]["component"];
}

describe("isMcpOpenable (fails-closed security invariant)", () => {
  afterEach(() => {
    __resetRegistryForTests();
  });

  test("unknown/unregistered panel type is not openable", () => {
    expect(isMcpOpenable("does-not-exist")).toBe(false);
  });

  test("a registered type with mcpOpenable:false is not openable", () => {
    registerPanelType("terminal", {
      component: stubComponent(),
      title: "Terminal",
      mcpOpenable: false,
    });
    expect(isMcpOpenable("terminal")).toBe(false);
  });

  test("a registered type with mcpOpenable:true is openable", () => {
    registerPanelType("sessions", {
      component: stubComponent(),
      title: "Sessions",
      mcpOpenable: true,
    });
    expect(isMcpOpenable("sessions")).toBe(true);
  });

  test("a registered type with mcpOpenable omitted defaults to openable", () => {
    registerPanelType("roster", {
      component: stubComponent(),
      title: "Roster",
    });
    expect(isMcpOpenable("roster")).toBe(true);
  });
});
