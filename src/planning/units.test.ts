/**
 * Behavioral tests for the narrow, explicit implementation-unit tracking
 * grammar (U2). No heuristic Markdown interpretation: only the
 * documented `## Implementation Units` section and its top-level
 * `- [ ] **U<n>. Title**` markers are scanned.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { documentSlice, parseDocument } from "./document";
import { parseUnits } from "./units";

function loadFixture(name: string) {
  const source = readFileSync(join(import.meta.dir, "fixtures", name), "utf-8");
  const parsed = parseDocument(source);
  if (!parsed.ok) throw new Error(`fixture ${name} failed to parse`);
  return parsed.value;
}

describe("real repo plan corpus (happy path + declared edge cases)", () => {
  const document = loadFixture("plan-excerpt.md");
  const result = parseUnits(document);

  test("all 9 real units are found with stable U<n> keys", () => {
    const keys = result.units.map((u) => u.key);
    expect(keys).toEqual([
      "U1",
      "U2",
      "U3",
      "U4",
      "U5",
      "U6",
      "U7",
      "U8",
      "U9",
    ]);
  });

  test("checkbox state is preserved as literal source content", () => {
    const u1 = result.units.find((u) => u.key === "U1");
    expect(u1?.checked).toBe(true); // "- [x] **U1. ...**" in the real plan
    const u2 = result.units.find((u) => u.key === "U2");
    expect(u2?.checked).toBe(false); // "- [ ] **U2. ...**"
  });

  test("U1 dependencies: explicit 'None' with no keys", () => {
    const u1 = result.units.find((u) => u.key === "U1");
    expect(u1?.dependencies).toEqual({ kind: "none" });
  });

  test("U2/U3 dependencies: single reference each", () => {
    const u2 = result.units.find((u) => u.key === "U2");
    const u3 = result.units.find((u) => u.key === "U3");
    expect(u2?.dependencies).toEqual({ kind: "keys", keys: ["U1"] });
    expect(u3?.dependencies).toEqual({ kind: "keys", keys: ["U1"] });
  });

  test("U4 dependencies: declaration list only, self-mention in trailing prose excluded", () => {
    const u4 = result.units.find((u) => u.key === "U4");
    expect(u4?.dependencies).toEqual({
      kind: "keys",
      keys: ["U1", "U2", "U3"],
    });
  });

  test("U6/U7/U8 dependencies parse compound and slash-joined references", () => {
    const u6 = result.units.find((u) => u.key === "U6");
    const u7 = result.units.find((u) => u.key === "U7");
    const u8 = result.units.find((u) => u.key === "U8");
    expect(u6?.dependencies).toEqual({
      kind: "keys",
      keys: ["U1", "U4", "U5"],
    });
    expect(u7?.dependencies).toEqual({
      kind: "keys",
      keys: ["U2", "U3", "U5"],
    });
    expect(u8?.dependencies).toEqual({ kind: "keys", keys: ["U5", "U6"] });
  });

  test("U5 dependencies: explicit comma-separated list, not a range", () => {
    const u5 = result.units.find((u) => u.key === "U5");
    expect(u5?.dependencies).toEqual({
      kind: "keys",
      keys: ["U2", "U3", "U4"],
    });
  });

  test("U9 dependencies: explicit comma-separated list of all 8 prior units", () => {
    const u9 = result.units.find((u) => u.key === "U9");
    expect(u9?.dependencies).toEqual({
      kind: "keys",
      keys: ["U1", "U2", "U3", "U4", "U5", "U6", "U7", "U8"],
    });
  });

  test("the live plan's dependency declarations produce zero structural issues (not merely 'has some issues')", () => {
    expect(result.issues).toEqual([]);
  });

  test("every unit's dependencies resolve to a valid, non-invalid kind", () => {
    for (const unit of result.units) {
      expect(unit.dependencies.kind).not.toBe("invalid");
    }
  });

  test("criteria fields are collected from Verification and Test scenarios", () => {
    const u1 = result.units.find((u) => u.key === "U1");
    const labels = u1?.criteria.map((c) => c.label).sort();
    expect(labels).toEqual(["Test scenarios", "Verification"]);
  });

  test("no criteria are fabricated for a field that is not present", () => {
    for (const unit of result.units) {
      for (const field of unit.criteria) {
        expect([
          "Verification",
          "Acceptance criteria",
          "Test scenarios",
        ]).toContain(field.label);
      }
    }
  });

  test("full unit source ranges preserve the exact original text", () => {
    const u2 = result.units.find((u) => u.key === "U2");
    expect(u2).toBeDefined();
    if (!u2) return;
    const text = documentSlice(document, u2.range);
    expect(text.startsWith("- [ ] **U2.")).toBe(true);
    expect(text).toContain("**Dependencies:** U1");
  });
});

describe("integration: the actual current plan document (not the fixture excerpt)", () => {
  // Reads docs/plans/2026-09-07-001-feat-agent-native-planning-plan.md
  // directly, read-only. Guards against plan-excerpt.md drifting stale
  // and silently masking a grammar regression against the live plan.
  const planPath = join(
    import.meta.dir,
    "..",
    "..",
    "docs",
    "plans",
    "2026-09-07-001-feat-agent-native-planning-plan.md",
  );
  const source = readFileSync(planPath, "utf-8");
  const parsed = parseDocument(source);
  if (!parsed.ok) throw new Error("live plan document failed to parse");
  const result = parseUnits(parsed.value);

  test("the live plan parses all 9 units with zero structural issues", () => {
    expect(result.units.map((u) => u.key)).toEqual([
      "U1",
      "U2",
      "U3",
      "U4",
      "U5",
      "U6",
      "U7",
      "U8",
      "U9",
    ]);
    expect(result.issues).toEqual([]);
  });

  test("the live plan's U5/U9 dependencies are explicit key lists, not ambiguous ranges", () => {
    const u5 = result.units.find((u) => u.key === "U5");
    const u9 = result.units.find((u) => u.key === "U9");
    expect(u5?.dependencies).toEqual({
      kind: "keys",
      keys: ["U2", "U3", "U4"],
    });
    expect(u9?.dependencies).toEqual({
      kind: "keys",
      keys: ["U1", "U2", "U3", "U4", "U5", "U6", "U7", "U8"],
    });
  });
});

describe("masking: frontmatter, fences, comments, and indented code are ignored", () => {
  const document = loadFixture("edge-syntax.md");
  const result = parseUnits(document);

  test("only the two units in the real section are found", () => {
    expect(result.units.map((u) => u.key)).toEqual(["U1", "U2"]);
  });

  test("no fake units from frontmatter, comments, or fences leak through", () => {
    expect(result.units.some((u) => u.key === "U3")).toBe(false);
    expect(result.units.some((u) => u.key === "U4")).toBe(false);
    expect(result.units.some((u) => u.key === "U5")).toBe(false);
    expect(result.units.some((u) => u.key === "U6")).toBe(false);
    expect(result.units.some((u) => u.key === "U7")).toBe(false);
    expect(result.units.some((u) => u.key === "U8")).toBe(false);
    expect(result.units.some((u) => u.key === "U9")).toBe(false);
  });

  test("section ends before the next same/higher heading; U3 outside it is not scanned", () => {
    expect(result.units.some((u) => u.key === "U3")).toBe(false);
  });
});

describe("per-mask isolation: each masked construct independently hides fake units", () => {
  test("frontmatter: a fake unit marker inside frontmatter is not parsed; a real unit right after is", () => {
    const source = `---
title: fixture
fake: "- [ ] **U9. Fake in frontmatter**"
---

## Implementation Units

- [ ] **U1. Real unit**

**Dependencies:** None
`;
    const doc = parseDocument(source);
    if (!doc.ok) throw new Error("fixture must parse");
    const result = parseUnits(doc.value);
    expect(result.units.map((u) => u.key)).toEqual(["U1"]);
    expect(doc.value.source).toContain("Fake in frontmatter");
  });

  test("BOM + frontmatter: a fake unit inside frontmatter after a leading BOM is not parsed", () => {
    const source = `\uFEFF---
title: fixture
fake: "- [ ] **U9. Fake after BOM**"
---

## Implementation Units

- [ ] **U1. Real unit**

**Dependencies:** None
`;
    const doc = parseDocument(source);
    if (!doc.ok) throw new Error("fixture must parse");
    const result = parseUnits(doc.value);
    expect(result.units.map((u) => u.key)).toEqual(["U1"]);
    expect(doc.value.source.startsWith("\uFEFF")).toBe(true);
    expect(doc.value.source).toContain("Fake after BOM");
  });

  test("a longer backtick fence containing a shorter backtick fence does not close early", () => {
    const source = `## Implementation Units

\`\`\`\`
outer fence, contains:
\`\`\`
- [ ] **U9. Fake in inner shorter fence**
\`\`\`
still inside outer
\`\`\`\`

- [ ] **U1. Real unit right after**

**Dependencies:** None
`;
    const doc = parseDocument(source);
    if (!doc.ok) throw new Error("fixture must parse");
    const result = parseUnits(doc.value);
    expect(result.units.map((u) => u.key)).toEqual(["U1"]);
    expect(doc.value.source).toContain("Fake in inner shorter fence");
  });

  test("a tilde fence hides a fake unit; a real unit right after the close is parsed", () => {
    const source = `## Implementation Units

~~~
- [ ] **U9. Fake in tilde fence**
~~~

- [ ] **U1. Real unit right after**

**Dependencies:** None
`;
    const doc = parseDocument(source);
    if (!doc.ok) throw new Error("fixture must parse");
    const result = parseUnits(doc.value);
    expect(result.units.map((u) => u.key)).toEqual(["U1"]);
    expect(doc.value.source).toContain("Fake in tilde fence");
  });

  test("an HTML comment hides a fake unit and its fake Dependencies label; a real unit right after is parsed", () => {
    const source = `## Implementation Units

<!--
- [ ] **U9. Fake in comment**
**Dependencies:** U1
-->

- [ ] **U1. Real unit right after**

**Dependencies:** None
`;
    const doc = parseDocument(source);
    if (!doc.ok) throw new Error("fixture must parse");
    const result = parseUnits(doc.value);
    expect(result.units.map((u) => u.key)).toEqual(["U1"]);
    expect(doc.value.source).toContain("Fake in comment");
  });

  test("an indented code block hides a fake unit; a real unit right after is parsed", () => {
    const source = `## Implementation Units

    - [ ] **U9. Fake in indented code**

- [ ] **U1. Real unit right after**

**Dependencies:** None
`;
    const doc = parseDocument(source);
    if (!doc.ok) throw new Error("fixture must parse");
    const result = parseUnits(doc.value);
    expect(result.units.map((u) => u.key)).toEqual(["U1"]);
    expect(doc.value.source).toContain("Fake in indented code");
  });

  test("a masked HTML comment INSIDE a real unit's range is preserved verbatim in that unit's source range, not excised", () => {
    const source = `## Implementation Units

- [ ] **U1. Real unit**

**Dependencies:** None

<!-- internal note, not a field: - [ ] **U9. Fake nested** -->

**Verification:** ok.
`;
    const doc = parseDocument(source);
    if (!doc.ok) throw new Error("fixture must parse");
    const result = parseUnits(doc.value);
    expect(result.units.map((u) => u.key)).toEqual(["U1"]);
    const u1 = result.units[0];
    expect(u1).toBeDefined();
    if (!u1) return;
    const unitText = documentSlice(doc.value, u1.range);
    expect(unitText).toContain("internal note, not a field");
    expect(unitText).toContain("Fake nested");
    const verification = u1.criteria.find((c) => c.label === "Verification");
    expect(verification).toBeDefined();
  });
});

describe("rename/reorder preserves unit key identity", () => {
  const base = `## Implementation Units

- [ ] **U1. Original title**

**Dependencies:** None

**Verification:** ok.

- [ ] **U2. Second**

**Dependencies:** U1

**Verification:** ok.
`;

  const reorderedAndRenamed = `## Implementation Units

- [ ] **U2. Renamed second unit**

**Dependencies:** U1

**Verification:** ok.

- [x] **U1. Renamed first unit**

**Dependencies:** None

**Verification:** ok.
`;

  test("keys are stable across title changes and reordering", () => {
    const beforeDoc = parseDocument(base);
    const afterDoc = parseDocument(reorderedAndRenamed);
    if (!beforeDoc.ok || !afterDoc.ok) throw new Error("fixtures must parse");

    const before = parseUnits(beforeDoc.value);
    const after = parseUnits(afterDoc.value);

    expect(before.units.map((u) => u.key).sort()).toEqual(
      after.units.map((u) => u.key).sort(),
    );
    const afterU1 = after.units.find((u) => u.key === "U1");
    const afterU2 = after.units.find((u) => u.key === "U2");
    expect(afterU1?.title).toBe("Renamed first unit");
    expect(afterU2?.dependencies).toEqual({ kind: "keys", keys: ["U1"] });
  });
});

describe("error: missing/duplicate/malformed unit structure", () => {
  test("missing section yields an explicit non-trackable diagnostic, no invented units", () => {
    const doc = parseDocument("# No units section here\n\nJust prose.\n");
    if (!doc.ok) throw new Error("fixture must parse");
    const result = parseUnits(doc.value);
    expect(result.units).toHaveLength(0);
    expect(result.issues.some((i) => i.kind === "missing-section")).toBe(true);
  });

  test("duplicate keys exclude both instances and raise a diagnostic", () => {
    const source = `## Implementation Units

- [ ] **U1. First copy**

**Dependencies:** None

- [ ] **U1. Second copy**

**Dependencies:** None
`;
    const doc = parseDocument(source);
    if (!doc.ok) throw new Error("fixture must parse");
    const result = parseUnits(doc.value);
    expect(result.units.some((u) => u.key === "U1")).toBe(false);
    expect(result.issues.some((i) => i.kind === "duplicate-key")).toBe(true);
  });

  test("a leading-zero key is malformed, not silently accepted", () => {
    const source = `## Implementation Units

- [ ] **U01. Leading zero**

**Dependencies:** None
`;
    const doc = parseDocument(source);
    if (!doc.ok) throw new Error("fixture must parse");
    const result = parseUnits(doc.value);
    expect(result.units).toHaveLength(0);
    expect(result.issues.some((i) => i.kind === "malformed-marker")).toBe(true);
  });
});

describe("dependency validity: unknown, self, and cycle references", () => {
  test("error: an unknown dependency key is invalid, not silently dropped", () => {
    const source = `## Implementation Units

- [ ] **U1. Alone**

**Dependencies:** U99
`;
    const doc = parseDocument(source);
    if (!doc.ok) throw new Error("fixture must parse");
    const result = parseUnits(doc.value);
    const u1 = result.units.find((u) => u.key === "U1");
    expect(u1?.dependencies.kind).toBe("invalid");
    expect(
      result.issues.some(
        (i) => i.kind === "unknown-dependency" && i.unitKey === "U1",
      ),
    ).toBe(true);
  });

  test("error: a unit that lists itself as a dependency is invalid", () => {
    const source = `## Implementation Units

- [ ] **U1. Self referencer**

**Dependencies:** U1
`;
    const doc = parseDocument(source);
    if (!doc.ok) throw new Error("fixture must parse");
    const result = parseUnits(doc.value);
    const u1 = result.units.find((u) => u.key === "U1");
    expect(u1?.dependencies.kind).toBe("invalid");
    expect(
      result.issues.some(
        (i) => i.kind === "self-dependency" && i.unitKey === "U1",
      ),
    ).toBe(true);
  });

  test("error: a dependency cycle is invalid for every unit in the cycle", () => {
    const source = `## Implementation Units

- [ ] **U1. A**

**Dependencies:** U2

- [ ] **U2. B**

**Dependencies:** U1
`;
    const doc = parseDocument(source);
    if (!doc.ok) throw new Error("fixture must parse");
    const result = parseUnits(doc.value);
    const u1 = result.units.find((u) => u.key === "U1");
    const u2 = result.units.find((u) => u.key === "U2");
    expect(u1?.dependencies.kind).toBe("invalid");
    expect(u2?.dependencies.kind).toBe("invalid");
    expect(result.issues.some((i) => i.kind === "dependency-cycle")).toBe(true);
  });

  test("contradictory 'None' plus explicit keys is invalid", () => {
    const source = `## Implementation Units

- [ ] **U1. First**

**Dependencies:** None

- [ ] **U2. Second**

**Dependencies:** None, U1
`;
    const doc = parseDocument(source);
    if (!doc.ok) throw new Error("fixture must parse");
    const result = parseUnits(doc.value);
    const u2 = result.units.find((u) => u.key === "U2");
    expect(u2?.dependencies.kind).toBe("invalid");
  });
});

describe("multiline Dependencies field", () => {
  test("keys spanning lines before the annotation boundary are captured; a U-key in trailing annotation prose is excluded", () => {
    const source = `## Implementation Units

- [ ] **U1. Title**

**Dependencies:**
U2, U3
before annotation. Then U4 is mentioned only in prose here, not a real dependency.

**Verification:** ok.

- [ ] **U2. Dep target**

**Dependencies:** None

- [ ] **U3. Dep target**

**Dependencies:** None

- [ ] **U4. Dep target**

**Dependencies:** None
`;
    const doc = parseDocument(source);
    if (!doc.ok) throw new Error("fixture must parse");
    const result = parseUnits(doc.value);
    const u1 = result.units.find((u) => u.key === "U1");
    expect(u1?.dependencies).toEqual({ kind: "keys", keys: ["U2", "U3"] });
  });

  test("the Dependencies field range covers exactly its own lines, not the following Verification field", () => {
    const source = `## Implementation Units

- [ ] **U1. Title**

**Dependencies:**
U2, U3
before annotation. Then U4 is mentioned only in prose here, not a real dependency.

**Verification:** ok.

- [ ] **U2. Dep target**

**Dependencies:** None

- [ ] **U3. Dep target**

**Dependencies:** None

- [ ] **U4. Dep target**

**Dependencies:** None
`;
    const doc = parseDocument(source);
    if (!doc.ok) throw new Error("fixture must parse");
    const result = parseUnits(doc.value);
    const u1 = result.units.find((u) => u.key === "U1");
    expect(u1?.dependenciesRange).toBeDefined();
    if (!u1?.dependenciesRange) return;
    const text = documentSlice(doc.value, u1.dependenciesRange);
    expect(text).toContain("U2, U3");
    expect(text).toContain("before annotation");
    expect(text).not.toContain("Verification");
  });

  test("a Dependencies field never swallows unrelated bold-labeled fields (Files/Approach) that follow it", () => {
    const source = `## Implementation Units

- [ ] **U1. Title**

**Dependencies:** U2 model.

**Files:**
- Create: \`src/planning/foo.ts\`.

**Approach:** Native storage in U3 retains full revision bytes; do not treat this as a U1 dependency.

**Verification:** ok.

- [ ] **U2. Dep target**

**Dependencies:** None

- [ ] **U3. Dep target**

**Dependencies:** None
`;
    const doc = parseDocument(source);
    if (!doc.ok) throw new Error("fixture must parse");
    const result = parseUnits(doc.value);
    const u1 = result.units.find((u) => u.key === "U1");
    expect(u1?.dependencies).toEqual({ kind: "keys", keys: ["U2"] });
  });
});

describe("multiline criteria fields: blank lines and fenced examples must not truncate declared criteria", () => {
  test("a blank line inside a Test scenarios block does not silently truncate later bullets", () => {
    const source = `## Implementation Units

- [ ] **U1. Title**

**Dependencies:** None

**Test scenarios:**
- item one
- item two

- item three, separated by a blank line for grouping

**Verification:** ok.
`;
    const doc = parseDocument(source);
    if (!doc.ok) throw new Error("fixture must parse");
    const result = parseUnits(doc.value);
    const u1 = result.units.find((u) => u.key === "U1");
    const scenarios = u1?.criteria.find((c) => c.label === "Test scenarios");
    expect(scenarios).toBeDefined();
    if (!scenarios) return;
    const text = documentSlice(doc.value, scenarios.range);
    expect(text).toContain("item one");
    expect(text).toContain("item two");
    expect(text).toContain("item three");
    expect(text).not.toContain("Verification");
  });

  test("a fenced example inside a Test scenarios block (with its own blank lines) is preserved, not truncated", () => {
    const source = `## Implementation Units

- [ ] **U1. Title**

**Dependencies:** None

**Test scenarios:**
- Happy path: round-trips this example:

\`\`\`json
{ "a": 1 }
\`\`\`

- Edge: after the fenced example too.

**Verification:** ok.
`;
    const doc = parseDocument(source);
    if (!doc.ok) throw new Error("fixture must parse");
    const result = parseUnits(doc.value);
    const u1 = result.units.find((u) => u.key === "U1");
    const scenarios = u1?.criteria.find((c) => c.label === "Test scenarios");
    expect(scenarios).toBeDefined();
    if (!scenarios) return;
    const text = documentSlice(doc.value, scenarios.range);
    expect(text).toContain('{ "a": 1 }');
    expect(text).toContain("Edge: after the fenced example");
    expect(text).not.toContain("Verification");
  });

  test("the field still stops at the next real bold-label boundary, never swallowing Verification into Test scenarios", () => {
    const source = `## Implementation Units

- [ ] **U1. Title**

**Dependencies:** None

**Test scenarios:**
- one

**Verification:** distinct text that must not appear inside Test scenarios.
`;
    const doc = parseDocument(source);
    if (!doc.ok) throw new Error("fixture must parse");
    const result = parseUnits(doc.value);
    const u1 = result.units.find((u) => u.key === "U1");
    const scenarios = u1?.criteria.find((c) => c.label === "Test scenarios");
    const verification = u1?.criteria.find((c) => c.label === "Verification");
    expect(scenarios).toBeDefined();
    expect(verification).toBeDefined();
    if (!scenarios || !verification) return;
    const scenariosText = documentSlice(doc.value, scenarios.range);
    expect(scenariosText).not.toContain("distinct text");
    const verificationText = documentSlice(doc.value, verification.range);
    expect(verificationText).toContain("distinct text");
  });
});

describe("integration: CRLF and BOM documents parse identically to LF", () => {
  test("CRLF line endings do not break section/marker detection", () => {
    const lf =
      "## Implementation Units\r\n\r\n- [ ] **U1. Title**\r\n\r\n**Dependencies:** None\r\n\r\n**Verification:** ok.\r\n";
    const doc = parseDocument(lf);
    if (!doc.ok) throw new Error("fixture must parse");
    const result = parseUnits(doc.value);
    expect(result.units.map((u) => u.key)).toEqual(["U1"]);
    expect(result.units[0]?.dependencies).toEqual({ kind: "none" });
  });

  test("a leading BOM does not break section detection", () => {
    const source =
      "\uFEFF## Implementation Units\n\n- [ ] **U1. Title**\n\n**Dependencies:** None\n";
    const doc = parseDocument(source);
    if (!doc.ok) throw new Error("fixture must parse");
    const result = parseUnits(doc.value);
    expect(result.units.map((u) => u.key)).toEqual(["U1"]);
  });
});
