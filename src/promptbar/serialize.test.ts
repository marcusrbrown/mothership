import { describe, expect, test } from "bun:test";
import { serializeDocToText } from "./serialize";

describe("serializeDocToText", () => {
  test("plain text paragraph", () => {
    const doc = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "hello world" }] },
      ],
    };
    expect(serializeDocToText(doc)).toBe("hello world");
  });

  test("doc with mention nodes serializes to @name references", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "delegate to " },
            {
              type: "mention",
              attrs: { id: "fro-bot/dashboard", label: "fro-bot/dashboard" },
            },
            { type: "text", text: " please" },
          ],
        },
      ],
    };
    expect(serializeDocToText(doc)).toBe(
      "delegate to @fro-bot/dashboard please",
    );
  });

  test("degraded mention (label missing, falls back to id)", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "mention", attrs: { id: "stale-session" } }],
        },
      ],
    };
    expect(serializeDocToText(doc)).toBe("@stale-session");
  });

  test("multiple paragraphs joined with newlines, trailing blank trimmed", () => {
    const doc = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "line 1" }] },
        { type: "paragraph", content: [{ type: "text", text: "line 2" }] },
        { type: "paragraph", content: [] },
      ],
    };
    expect(serializeDocToText(doc)).toBe("line 1\nline 2");
  });

  test("hardBreak within a paragraph becomes a newline", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "a" },
            { type: "hardBreak" },
            { type: "text", text: "b" },
          ],
        },
      ],
    };
    expect(serializeDocToText(doc)).toBe("a\nb");
  });

  test("empty doc serializes to empty string", () => {
    expect(serializeDocToText({ type: "doc", content: [] })).toBe("");
  });
});
