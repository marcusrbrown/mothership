import { describe, expect, test } from "bun:test";
import type { BusContext } from "../server/types";
import {
  firstMentionedProject,
  leadingPlainTextMentionProject,
  resolveMentionedProject,
} from "./mention-route";
import type { JSONDoc } from "./serialize";

const context: BusContext = {
  roster: {
    server: { baseUrl: "http://127.0.0.1:4096" },
    projects: [
      {
        name: "fro-bot/dashboard",
        path: "~/src/fro-bot/dashboard",
        expandedPath: "/Users/marcus/src/fro-bot/dashboard",
        description: "",
        exists: true,
      },
      {
        name: "fro-bot/agent",
        path: "~/src/fro-bot/agent",
        expandedPath: "/Users/marcus/src/fro-bot/agent",
        description: "",
        exists: true,
      },
    ],
  },
} as unknown as BusContext;

function docWithMention(id: string): JSONDoc {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "mention", attrs: { id, label: id } },
          { type: "text", text: " summarize" },
        ],
      },
    ],
  };
}

const emptyDoc: JSONDoc = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }],
};

describe("firstMentionedProject", () => {
  test("finds a mention node naming a real roster project", () => {
    expect(
      firstMentionedProject(docWithMention("fro-bot/agent"), context),
    ).toBe("fro-bot/agent");
  });

  test("no mention node -> undefined", () => {
    expect(firstMentionedProject(emptyDoc, context)).toBeUndefined();
  });
});

describe("leadingPlainTextMentionProject (bug A′)", () => {
  test("leading @word matching the LAST path segment of a roster project routes to it", () => {
    expect(
      leadingPlainTextMentionProject(
        "@dashboard summarize the latest commit",
        context,
      ),
    ).toBe("fro-bot/dashboard");
  });

  test("leading @word matching the FULL roster project name also routes", () => {
    expect(
      leadingPlainTextMentionProject("@fro-bot/agent do the thing", context),
    ).toBe("fro-bot/agent");
  });

  test("matching is case-insensitive", () => {
    expect(leadingPlainTextMentionProject("@DASHBOARD hello", context)).toBe(
      "fro-bot/dashboard",
    );
  });

  test("a mid-text @word (not leading) does not route", () => {
    expect(
      leadingPlainTextMentionProject(
        "email me at foo@bar.com about dashboard",
        context,
      ),
    ).toBeUndefined();
  });

  test("leading @word naming no real project -> undefined", () => {
    expect(
      leadingPlainTextMentionProject("@nonexistent do stuff", context),
    ).toBeUndefined();
  });

  test("no leading @ at all -> undefined", () => {
    expect(
      leadingPlainTextMentionProject("just a plain prompt", context),
    ).toBeUndefined();
  });

  test("leading/trailing whitespace before the @ is trimmed before matching", () => {
    expect(leadingPlainTextMentionProject("   @dashboard hi", context)).toBe(
      "fro-bot/dashboard",
    );
  });
});

describe("resolveMentionedProject (combined)", () => {
  test("mention NODE wins even when a leading plain-text @word also names a different project", () => {
    // doc has a mention node for fro-bot/agent; text (as it would serialize)
    // leads with a DIFFERENT plain @word.
    const doc = docWithMention("fro-bot/agent");
    const text = "@dashboard summarize";
    expect(resolveMentionedProject(doc, text, context)).toBe("fro-bot/agent");
  });

  test("no mention node -> falls back to leading plain-text scan", () => {
    expect(
      resolveMentionedProject(
        emptyDoc,
        "@dashboard summarize the latest commit",
        context,
      ),
    ).toBe("fro-bot/dashboard");
  });

  test("neither present -> undefined", () => {
    expect(
      resolveMentionedProject(emptyDoc, "plain text", context),
    ).toBeUndefined();
  });
});
