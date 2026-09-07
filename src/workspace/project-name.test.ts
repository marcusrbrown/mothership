import { describe, expect, test } from "bun:test";
import {
  FALLBACK_VIRTUAL_PROJECT_NAME,
  isValidProjectName,
} from "./project-name";

describe("isValidProjectName", () => {
  test("happy path: a plain name is valid", () => {
    expect(isValidProjectName("dashboard")).toBe(true);
  });

  test("happy path: org/repo-style internal slash is valid", () => {
    expect(isValidProjectName("fro-bot/dashboard")).toBe(true);
  });

  test("happy path: spaces, punctuation, and Unicode are preserved/valid", () => {
    expect(isValidProjectName("My Project (2024)")).toBe(true);
    expect(isValidProjectName("café ☕")).toBe(true);
    expect(isValidProjectName("プロジェクト")).toBe(true);
  });

  test("error path: absolute path is rejected", () => {
    expect(isValidProjectName("/Users/marcus/src/dashboard")).toBe(false);
  });

  test("error path: home-dir shorthand is rejected", () => {
    expect(isValidProjectName("~/x")).toBe(false);
  });

  test("error path: relative dot-segments are rejected", () => {
    expect(isValidProjectName(".")).toBe(false);
    expect(isValidProjectName("..")).toBe(false);
    expect(isValidProjectName("foo/../bar")).toBe(false);
  });

  test("error path: Windows-shaped paths are rejected", () => {
    expect(isValidProjectName("C:\\Users\\marcus")).toBe(false);
    expect(isValidProjectName("C:/Users/marcus")).toBe(false);
    expect(isValidProjectName("a\\b")).toBe(false);
  });

  test("error path: control characters are rejected", () => {
    expect(isValidProjectName("foo\u0000bar")).toBe(false);
    expect(isValidProjectName("foo\nbar")).toBe(false);
  });

  test("error path: credential/header-shaped values are rejected", () => {
    expect(isValidProjectName("Bearer abc123xyz")).toBe(false);
    expect(isValidProjectName("Authorization: Bearer xyz")).toBe(false);
    expect(isValidProjectName("password=hunter2")).toBe(false);
    expect(isValidProjectName("token: secretvalue")).toBe(false);
  });

  test("edge case: empty string and oversized names are rejected", () => {
    expect(isValidProjectName("")).toBe(false);
    expect(isValidProjectName("a".repeat(201))).toBe(false);
  });
});

describe("FALLBACK_VIRTUAL_PROJECT_NAME", () => {
  test("is itself a valid project name and never contains a path", () => {
    expect(isValidProjectName(FALLBACK_VIRTUAL_PROJECT_NAME)).toBe(true);
    expect(FALLBACK_VIRTUAL_PROJECT_NAME).not.toContain("/");
  });
});
