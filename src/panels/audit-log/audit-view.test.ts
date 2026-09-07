import { describe, expect, test } from "bun:test";
import {
  formatResult,
  getActionName,
  getCategory,
  parseParamSummary,
} from "./audit-view";

describe("audit-view metadata parsing", () => {
  test("parses simple key-value pairs and unquotes values", () => {
    const summary = 'panelId="panel_1" panelType="terminal" direction="left"';
    const parsed = parseParamSummary(summary);
    expect(parsed).toEqual([
      { key: "panelId", value: "panel_1" },
      { key: "panelType", value: "terminal" },
      { key: "direction", value: "left" },
    ]);
  });

  test("filters out sensitive or unapproved keys", () => {
    const summary =
      'sessionId="ses_123" secretToken="super-secret" project="fro-bot/dashboard"';
    const parsed = parseParamSummary(summary);
    expect(parsed).toEqual([
      { key: "sessionId", value: "ses_123" },
      { key: "project", value: "fro-bot/dashboard" },
    ]);
  });

  test("parses bytes and truncated flags", () => {
    const summary = "project=fro-bot/dashboard bytes=128/1024 truncated=true";
    const parsed = parseParamSummary(summary);
    expect(parsed).toEqual([
      { key: "project", value: "fro-bot/dashboard" },
      { key: "bytes", value: "128/1024" },
      { key: "truncated", value: "true" },
    ]);
  });
});

describe("audit-view category resolution", () => {
  test("identifies read-only ide_* operations as READ", () => {
    expect(getCategory("ide_list_sessions")).toBe("READ");
    expect(getCategory("ide_list_projects")).toBe("READ");
    expect(getCategory("ide_read_transcript")).toBe("READ");
  });

  test("identifies mutative ide_* operations as SESSION", () => {
    expect(getCategory("ide_dispatch_prompt")).toBe("SESSION");
    expect(getCategory("ide_answer_question")).toBe("SESSION");
    expect(getCategory("ide_focus_session")).toBe("SESSION");
  });

  test("identifies native/layout operations as LAYOUT", () => {
    expect(getCategory("open_panel")).toBe("LAYOUT");
    expect(getCategory("layout_changed_native")).toBe("LAYOUT");
  });
});

describe("audit-view action name mapping", () => {
  test("removes the ide_ prefix from session tool commands", () => {
    expect(getActionName("ide_list_sessions")).toBe("list_sessions");
    expect(getActionName("ide_dispatch_prompt")).toBe("dispatch_prompt");
  });

  test("leaves layout commands intact", () => {
    expect(getActionName("open_panel")).toBe("open_panel");
    expect(getActionName("layout_changed_native")).toBe(
      "layout_changed_native",
    );
  });
});

describe("audit-view result formatting", () => {
  test("formats ok outcome cleanly", () => {
    expect(formatResult("ok")).toEqual({ display: "OK", isError: false });
  });

  test("extracts and formats stable error codes", () => {
    expect(formatResult("error:unknown_session")).toEqual({
      display: "UNKNOWN_SESSION",
      isError: true,
    });
    expect(formatResult("error:invalid_arguments")).toEqual({
      display: "INVALID_ARGUMENTS",
      isError: true,
    });
  });

  test("redacts unexpected, free-form, or complex error fields to fallback ERROR", () => {
    expect(formatResult("error:something broke with path /etc/passwd")).toEqual(
      {
        display: "ERROR",
        isError: true,
      },
    );
    expect(formatResult("error:with spaces")).toEqual({
      display: "ERROR",
      isError: true,
    });
    expect(formatResult("error:invalid-characters!")).toEqual({
      display: "ERROR",
      isError: true,
    });
  });
});
