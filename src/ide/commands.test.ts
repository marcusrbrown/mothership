import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  isBrandedResultSchema,
  isValidProjectName,
  isValidSessionId,
  parseSessionToolArgs,
  projectOrSessionTargetSchema,
  projectTargetSchema,
  sessionResultSchema,
  sessionTargetSchema,
} from "./commands";

describe("isValidProjectName", () => {
  test("happy path: accepts a plain roster name", () => {
    expect(isValidProjectName("dashboard")).toBe(true);
  });

  test("happy path: accepts an org/repo-style name with an internal slash", () => {
    expect(isValidProjectName("fro-bot/dashboard")).toBe(true);
  });

  test("happy path: accepts dotted segments", () => {
    expect(isValidProjectName("foo.bar")).toBe(true);
  });

  test("error path: rejects an absolute POSIX path", () => {
    expect(isValidProjectName("/x")).toBe(false);
    expect(isValidProjectName("/Users/marcus/src/fro-bot/dashboard")).toBe(
      false,
    );
  });

  test("error path: rejects home-dir shorthand", () => {
    expect(isValidProjectName("~")).toBe(false);
    expect(isValidProjectName("~/x")).toBe(false);
  });

  test("error path: rejects explicit relative/dot segments", () => {
    expect(isValidProjectName(".")).toBe(false);
    expect(isValidProjectName("..")).toBe(false);
    expect(isValidProjectName("./x")).toBe(false);
    expect(isValidProjectName("../x")).toBe(false);
    expect(isValidProjectName("foo/../bar")).toBe(false);
    expect(isValidProjectName("foo/.")).toBe(false);
  });

  test("error path: rejects Windows drive letters, UNC paths, and backslashes", () => {
    expect(isValidProjectName("C:\\Users\\marcus")).toBe(false);
    expect(isValidProjectName("C:/Users/marcus")).toBe(false);
    expect(isValidProjectName("\\\\server\\share")).toBe(false);
    expect(isValidProjectName("a\\b")).toBe(false);
  });

  test("error path: rejects NUL and other control characters", () => {
    expect(isValidProjectName("foo\u0000bar")).toBe(false);
    expect(isValidProjectName("foo\u0007bar")).toBe(false);
    expect(isValidProjectName("foo\nbar")).toBe(false);
  });

  test("error path: rejects empty and overlong names", () => {
    expect(isValidProjectName("")).toBe(false);
    expect(isValidProjectName("a".repeat(201))).toBe(false);
  });

  test("error path: rejects a leading or trailing slash and double slashes", () => {
    expect(isValidProjectName("/foo")).toBe(false);
    expect(isValidProjectName("foo/")).toBe(false);
    expect(isValidProjectName("foo//bar")).toBe(false);
  });

  test("happy path: accepts a human roster title with spaces and punctuation", () => {
    expect(isValidProjectName("My Project")).toBe(true);
    expect(isValidProjectName("My Project (2024)")).toBe(true);
    expect(isValidProjectName("foo!bar, baz; qux'quux\"corge")).toBe(true);
  });

  test("happy path: accepts Unicode roster names", () => {
    expect(isValidProjectName("プロジェクト")).toBe(true);
    expect(isValidProjectName("Café Déjà Vu")).toBe(true);
    expect(isValidProjectName("مشروع")).toBe(true);
  });

  test("happy path: accepts real-shaped roster names — org/repo, dotted, hyphenated, underscored", () => {
    expect(isValidProjectName("fro-bot/dashboard")).toBe(true);
    expect(isValidProjectName("foo.bar")).toBe(true);
    expect(isValidProjectName("my_project-2")).toBe(true);
    expect(isValidProjectName("org/repo.name-2")).toBe(true);
  });

  test("error path: rejects credential/header-shaped values regardless of surrounding text", () => {
    expect(isValidProjectName("Bearer abc123xyz")).toBe(false);
    expect(isValidProjectName("password=hunter2")).toBe(false);
    expect(isValidProjectName("token:secretvalue")).toBe(false);
    expect(isValidProjectName("token: secretvalue")).toBe(false);
    expect(isValidProjectName("Authorization: Bearer xyz")).toBe(false);
    expect(isValidProjectName("Cookie=session=abc")).toBe(false);
    expect(isValidProjectName("api-key=abc123")).toBe(false);
    expect(isValidProjectName("api_key: abc123")).toBe(false);
    expect(isValidProjectName("secret=shh")).toBe(false);
    // A plain word alone (no colon/equals/Bearer-value shape) is fine —
    // it's the credential SHAPE that's rejected, not the word.
    expect(isValidProjectName("Authorization")).toBe(true);
    expect(isValidProjectName("my-token-project")).toBe(true);
  });
});

describe("isValidSessionId", () => {
  test("happy path: accepts an opaque session-shaped id", () => {
    expect(isValidSessionId("ses_08a38a67dffekFeYYji5iJVZck")).toBe(true);
  });

  test("error path: opaque identifiers are tightly bounded — no slashes at all", () => {
    expect(isValidSessionId("fro-bot/dashboard")).toBe(false);
    expect(isValidSessionId("a/b")).toBe(false);
  });

  test("error path: no dots either — session ids are not dotted names", () => {
    expect(isValidSessionId("foo.bar")).toBe(false);
  });

  test("error path: rejects path-shaped, home, and Windows values", () => {
    expect(isValidSessionId("/x")).toBe(false);
    expect(isValidSessionId("~/x")).toBe(false);
    expect(isValidSessionId("C:\\Users")).toBe(false);
  });

  test("error path: rejects control characters, empty, and overlong values", () => {
    expect(isValidSessionId("ses_\u0000bad")).toBe(false);
    expect(isValidSessionId("")).toBe(false);
    expect(isValidSessionId("a".repeat(129))).toBe(false);
  });

  test("error path: rejects whitespace and auth-header-shaped values", () => {
    expect(isValidSessionId("Bearer abc123")).toBe(false);
    expect(isValidSessionId("ses 1")).toBe(false);
  });
});

describe("projectTargetSchema", () => {
  test("happy path: accepts a logical project name, including org/repo and dotted forms", () => {
    expect(
      projectTargetSchema.safeParse({ project: "dashboard" }).success,
    ).toBe(true);
    expect(
      projectTargetSchema.safeParse({ project: "fro-bot/dashboard" }).success,
    ).toBe(true);
    expect(projectTargetSchema.safeParse({ project: "foo.bar" }).success).toBe(
      true,
    );
  });

  test("error path: rejects a directory-shaped project value", () => {
    expect(
      projectTargetSchema.safeParse({
        project: "/Users/marcus/src/fro-bot/dashboard",
      }).success,
    ).toBe(false);
    expect(projectTargetSchema.safeParse({ project: "~/x" }).success).toBe(
      false,
    );
    expect(
      projectTargetSchema.safeParse({ project: "../escape" }).success,
    ).toBe(false);
  });

  test("error path: rejects an empty project value", () => {
    expect(projectTargetSchema.safeParse({ project: "" }).success).toBe(false);
  });
});

describe("sessionTargetSchema", () => {
  test("happy path: accepts an opaque session id", () => {
    expect(
      sessionTargetSchema.safeParse({
        sessionId: "ses_08a38a67dffekFeYYji5iJVZck",
      }).success,
    ).toBe(true);
  });

  test("error path: rejects a directory-shaped sessionId value", () => {
    expect(
      sessionTargetSchema.safeParse({ sessionId: "~/src/fro-bot/dashboard" })
        .success,
    ).toBe(false);
  });

  test("error path: rejects an org/repo-slash-shaped sessionId — session ids never contain slashes", () => {
    expect(
      sessionTargetSchema.safeParse({ sessionId: "fro-bot/dashboard" }).success,
    ).toBe(false);
  });
});

describe("projectOrSessionTargetSchema", () => {
  test("happy path: accepts project alone", () => {
    expect(
      projectOrSessionTargetSchema.safeParse({ project: "dashboard" }).success,
    ).toBe(true);
  });

  test("happy path: accepts sessionId alone", () => {
    expect(
      projectOrSessionTargetSchema.safeParse({ sessionId: "ses_1" }).success,
    ).toBe(true);
  });

  test("error path: rejects both project and sessionId present", () => {
    expect(
      projectOrSessionTargetSchema.safeParse({
        project: "dashboard",
        sessionId: "ses_1",
      }).success,
    ).toBe(false);
  });

  test("error path: rejects neither project nor sessionId present", () => {
    expect(projectOrSessionTargetSchema.safeParse({}).success).toBe(false);
  });

  test("error path: rejects a directory-shaped project even alongside a missing sessionId", () => {
    expect(
      projectOrSessionTargetSchema.safeParse({ project: "../escape" }).success,
    ).toBe(false);
  });
});

describe("parseSessionToolArgs", () => {
  test("happy path: valid input parses to ok:true data", () => {
    const result = parseSessionToolArgs(projectTargetSchema, {
      project: "dashboard",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data.project).toBe("dashboard");
  });

  test("error path: directory-shaped target maps to invalid_target, not invalid_arguments", () => {
    const result = parseSessionToolArgs(projectTargetSchema, {
      project: "/etc/passwd",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.code).toBe("invalid_target");
    expect(result.error.delivery).toBe("not_sent");
  });

  test("error path: generic malformed input maps to invalid_arguments", () => {
    const result = parseSessionToolArgs(projectTargetSchema, {
      project: 42,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.code).toBe("invalid_arguments");
  });

  test("error path: non-object input never throws", () => {
    expect(() =>
      parseSessionToolArgs(projectTargetSchema, "not-an-object"),
    ).not.toThrow();
    expect(() => parseSessionToolArgs(projectTargetSchema, null)).not.toThrow();
    expect(() =>
      parseSessionToolArgs(projectTargetSchema, undefined),
    ).not.toThrow();
  });

  test("security: error messages never echo the rejected directory-shaped value verbatim as a credential/path leak vector beyond the field label", () => {
    const result = parseSessionToolArgs(projectTargetSchema, {
      project: "/Users/marcus/.ssh/id_rsa",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.message).not.toContain("/Users/marcus/.ssh/id_rsa");
  });
});

describe("sessionResultSchema / isBrandedResultSchema", () => {
  test("happy path: a schema built by sessionResultSchema is branded", () => {
    const schema = sessionResultSchema({ id: z.string() });
    expect(isBrandedResultSchema(schema)).toBe(true);
  });

  test("happy path: the built schema is strict — rejects any undeclared field", () => {
    const schema = sessionResultSchema({ id: z.string() });
    expect(schema.safeParse({ id: "x" }).success).toBe(true);
    expect(
      schema.safeParse({ id: "x", extra: "should not pass" }).success,
    ).toBe(false);
  });

  test("happy path: an empty-shape schema still parses {} and rejects any extra field", () => {
    const schema = sessionResultSchema({});
    expect(schema.safeParse({}).success).toBe(true);
    expect(schema.safeParse({ path: "/etc/passwd" }).success).toBe(false);
  });

  test("security: z.unknown() is NEVER treated as branded", () => {
    expect(isBrandedResultSchema(z.unknown())).toBe(false);
  });

  test("security: z.any() is NEVER treated as branded", () => {
    expect(isBrandedResultSchema(z.any())).toBe(false);
  });

  test("security: a hand-built z.object({}).passthrough() is NEVER treated as branded, even though it superficially resembles a real result schema", () => {
    expect(isBrandedResultSchema(z.object({}).passthrough())).toBe(false);
  });

  test("security: a hand-built z.object({}).catchall(z.unknown()) is NEVER treated as branded", () => {
    expect(isBrandedResultSchema(z.object({}).catchall(z.unknown()))).toBe(
      false,
    );
  });

  test("security: an unbounded z.record(...) is NEVER treated as branded", () => {
    expect(isBrandedResultSchema(z.record(z.string(), z.unknown()))).toBe(
      false,
    );
  });

  test("security: a hand-built z.object({...}).strict() that merely LOOKS identical to a sessionResultSchema output is still NOT branded — brand is checked by identity, never re-derived from shape", () => {
    const lookalike = z.object({ id: z.string() }).strict();
    expect(isBrandedResultSchema(lookalike)).toBe(false);
  });

  test("security: a schema built by sessionResultSchema, then later mutated with .passthrough(), is STILL branded by identity — the brand tracks the original instance, not current behavior. This is a documented limitation: definitions must not chain .passthrough()/.catchall() onto a branded schema after construction.", () => {
    // sessionResultSchema returns a NEW schema instance from
    // `.passthrough()` (zod schemas are immutable) — the ORIGINAL
    // branded instance is unaffected, but a caller holding only the new
    // instance has a schema that both is NOT branded (different object)
    // and no longer strict.
    const original = sessionResultSchema({ id: z.string() });
    // biome-ignore lint/suspicious/noExplicitAny: passthrough() widens the type; only object identity matters for this test.
    const widened = (original as any).passthrough();
    expect(isBrandedResultSchema(original)).toBe(true);
    expect(isBrandedResultSchema(widened)).toBe(false);
  });

  test("security: a non-ZodType value passed to isBrandedResultSchema never throws and is always rejected", () => {
    for (const bad of [null, undefined, "not-a-schema", 42, {}, []]) {
      expect(() => isBrandedResultSchema(bad)).not.toThrow();
      expect(isBrandedResultSchema(bad)).toBe(false);
    }
  });
});
