/**
 * Narrow, EXPLICIT implementation-unit tracking grammar (U2) — not a
 * general Markdown parser. Only the canonical `## Implementation Units`
 * section and its top-level `- [ ] **U<n>. Title**` markers are
 * meaningful; everything else in the document is opaque prose. The
 * checkbox is source CONTENT (part of approval-bearing identity in
 * revisions.ts), never backend progress. Missing/duplicate/malformed
 * keys and invalid dependency declarations are reported as explicit
 * issues — never guessed, expanded, or silently dropped.
 */
import type { PlanDocument, SourceRange } from "./document";

export type UnitDependencies =
  | { readonly kind: "none" }
  | { readonly kind: "keys"; readonly keys: readonly string[] }
  | { readonly kind: "invalid"; readonly reason: string };

export type CriteriaLabel =
  | "Verification"
  | "Acceptance criteria"
  | "Test scenarios";

export interface CriteriaField {
  readonly label: CriteriaLabel;
  readonly range: SourceRange;
}

export interface ParsedUnit {
  readonly key: string;
  readonly title: string;
  readonly checked: boolean;
  readonly range: SourceRange;
  readonly dependenciesRange?: SourceRange;
  readonly dependencies: UnitDependencies;
  readonly criteria: readonly CriteriaField[];
}

export type UnitsIssueKind =
  | "missing-section"
  | "malformed-marker"
  | "duplicate-key"
  | "unknown-dependency"
  | "self-dependency"
  | "dependency-cycle"
  | "ambiguous-dependency-range";

export interface UnitsIssue {
  readonly kind: UnitsIssueKind;
  readonly message: string;
  readonly range?: SourceRange;
  readonly unitKey?: string;
}

/**
 * `units` is not a raw marker inventory: a unit key declared more than once
 * (duplicate-key) is excluded from `units` entirely, and each duplicate
 * marker instead produces its own `duplicate-key` issue in `issues`. Any
 * other unit that referenced the excluded key as a dependency gets an
 * `unknown-dependency` issue (its `dependencies` becomes `{ kind: "invalid" }`)
 * — the excluded key is simply not a known key. Consumers that need a
 * trustworthy set of trackable units must require `issues.length === 0`;
 * `units` alone is not sufficient to detect this class of problem. The
 * underlying document/source is never mutated by parsing.
 */
export interface UnitsParseResult {
  readonly units: readonly ParsedUnit[];
  readonly issues: readonly UnitsIssue[];
}

// ---- line indexing -------------------------------------------------

interface Line {
  readonly content: string; // excludes trailing \r and \n
  readonly start: number; // UTF-16 offset of the line's first char
  readonly end: number; // UTF-16 offset just past the line (incl. \n)
}

function splitLines(source: string): Line[] {
  const lines: Line[] = [];
  const len = source.length;
  let start = 0;
  for (let i = 0; i <= len; i++) {
    if (i === len || source[i] === "\n") {
      let contentEnd = i;
      if (contentEnd > start && source[contentEnd - 1] === "\r") {
        contentEnd--;
      }
      lines.push({
        content: source.slice(start, contentEnd),
        start,
        end: i < len ? i + 1 : i,
      });
      start = i + 1;
    }
  }
  return lines;
}

// ---- masking: frontmatter / fenced code / HTML comments / indented code ----

const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/;

function computeMask(source: string, lines: Line[]): boolean[] {
  const mask = new Array<boolean>(lines.length).fill(false);

  // Frontmatter: a leading "---" line through the next "---"/"..." line.
  const firstContent = lines[0]?.content.replace(/^\uFEFF/, "").trim();
  if (firstContent === "---") {
    let closeIndex = -1;
    for (let i = 1; i < lines.length; i++) {
      const trimmed = lines[i]?.content.trim();
      if (trimmed === "---" || trimmed === "...") {
        closeIndex = i;
        break;
      }
    }
    if (closeIndex >= 0) {
      for (let i = 0; i <= closeIndex; i++) mask[i] = true;
    }
  }

  // Fenced code blocks (``` or ~~~, tilde/backtick, 3+ chars; closing
  // fence must use the same character and be at least as long).
  let fenceChar: string | null = null;
  let fenceLen = 0;
  for (let i = 0; i < lines.length; i++) {
    if (mask[i]) continue;
    const content = lines[i]?.content ?? "";
    if (fenceChar === null) {
      const match = FENCE_OPEN_RE.exec(content);
      if (match) {
        const run = match[1] ?? "";
        fenceChar = run[0] ?? null;
        fenceLen = run.length;
        mask[i] = true;
      }
      continue;
    }
    mask[i] = true;
    const closeMatch = new RegExp(
      `^ {0,3}(${fenceChar === "`" ? "`" : "~"}{${fenceLen},})\\s*$`,
    ).exec(content);
    if (closeMatch) {
      fenceChar = null;
      fenceLen = 0;
    }
  }

  // HTML comments: computed over raw char ranges, then intersected with lines.
  // matchAll yields matches in ascending source order and comment ranges never
  // overlap, and `lines` is itself sorted by ascending, non-overlapping
  // [start, end) offsets, so a single forward cursor suffices in place of a
  // per-match rescan of every line.
  const commentRe = /<!--[\s\S]*?-->/g;
  let lineCursor = 0;
  for (const match of source.matchAll(commentRe)) {
    const from = match.index;
    const to = from + match[0].length;
    while (lineCursor < lines.length && (lines[lineCursor]?.end ?? 0) <= from) {
      lineCursor++;
    }
    let idx = lineCursor;
    while (idx < lines.length && (lines[idx]?.start ?? 0) < to) {
      mask[idx] = true;
      idx++;
    }
    lineCursor = idx;
  }

  // Indented code: >=4 leading spaces or a leading tab, non-blank.
  for (let i = 0; i < lines.length; i++) {
    if (mask[i]) continue;
    const content = lines[i]?.content ?? "";
    if (content.trim() === "") continue;
    if (/^(?: {4,}|\t)/.test(content)) mask[i] = true;
  }

  return mask;
}

// ---- section location ------------------------------------------------

const SECTION_HEADING_RE = /^##\s+Implementation Units\s*$/;
const ANY_H1_H2_RE = /^#{1,2}(\s|$)/;

// ---- unit marker grammar ----------------------------------------------

const UNIT_MARKER_RE = /^- \[([ xX])\] \*\*(U([1-9]\d*))\. (.+)\*\*\s*$/;
const UNIT_MARKER_CANDIDATE_RE = /^- \[[^\]]?\] \*\*U\d*[.\s]/;

const FIELD_LABEL_RE =
  /^\*\*(Dependencies|Verification|Acceptance criteria|Test scenarios):\*\*(.*)$/;
const CRITERIA_LABELS: ReadonlySet<string> = new Set([
  "Verification",
  "Acceptance criteria",
  "Test scenarios",
]);
// ANY bold `**Label:**` line bounds a field's span, not just the four
// tracked labels above — otherwise Dependencies would swallow the
// following Files/Approach/etc. paragraphs. A blank line alone does NOT
// terminate a field: multi-paragraph criteria (blank-line-separated
// bullets, fenced examples) must not be silently truncated.
const ANY_BOLD_LABEL_RE = /^\*\*[^*\n]+:\*\*/;

interface MarkerCandidate {
  readonly lineIndex: number;
  readonly wellFormed: boolean;
  readonly key?: string;
  readonly title?: string;
  readonly checked?: boolean;
}

function findMarkerCandidates(
  lines: Line[],
  mask: boolean[],
  from: number,
  to: number,
): MarkerCandidate[] {
  const candidates: MarkerCandidate[] = [];
  for (let i = from; i < to; i++) {
    if (mask[i]) continue;
    const content = lines[i]?.content ?? "";
    const match = UNIT_MARKER_RE.exec(content);
    if (match) {
      candidates.push({
        lineIndex: i,
        wellFormed: true,
        key: match[2],
        title: match[4],
        checked: match[1]?.toLowerCase() === "x",
      });
      continue;
    }
    if (UNIT_MARKER_CANDIDATE_RE.test(content)) {
      candidates.push({ lineIndex: i, wellFormed: false });
    }
  }
  return candidates;
}

function findFieldRange(
  lines: Line[],
  mask: boolean[],
  from: number,
  to: number,
): { afterLabel: number; end: number } {
  const startLine = lines[from];
  const afterLabel = startLine ? startLine.start : 0;
  let end = lines[to]?.start ?? lines[lines.length - 1]?.end ?? 0;
  for (let i = from + 1; i < to; i++) {
    if (mask[i]) continue;
    const content = lines[i]?.content ?? "";
    if (ANY_BOLD_LABEL_RE.test(content)) {
      end = lines[i]?.start ?? end;
      break;
    }
  }
  return { afterLabel, end };
}

function parseDependenciesText(text: string): UnitDependencies {
  const declaration = (() => {
    const dotIdx = text.indexOf(".");
    const semiIdx = text.indexOf(";");
    const candidates = [dotIdx, semiIdx].filter((n) => n >= 0);
    if (candidates.length === 0) return text;
    return text.slice(0, Math.min(...candidates));
  })().trim();

  if (declaration.length === 0) {
    return { kind: "invalid", reason: "empty dependencies declaration" };
  }

  const RANGE_RE = /\bU[1-9]\d*[-\u2013]U[1-9]\d*\b/;
  if (RANGE_RE.test(declaration)) {
    return {
      kind: "invalid",
      reason: "ambiguous dependency range must not be expanded",
    };
  }

  const isNoneOnly = /^none$/i.test(declaration);
  const keyMatches = [...declaration.matchAll(/\bU([1-9]\d*)\b/g)].map(
    (m) => m[0],
  );

  if (isNoneOnly) return { kind: "none" };

  const hasNoneWord = /\bnone\b/i.test(declaration);
  if (hasNoneWord && keyMatches.length > 0) {
    return {
      kind: "invalid",
      reason: "contradictory 'None' combined with explicit dependency keys",
    };
  }

  if (keyMatches.length === 0) {
    return {
      kind: "invalid",
      reason: "dependencies field declares neither 'None' nor a key",
    };
  }

  const deduped = Array.from(new Set(keyMatches));
  return { kind: "keys", keys: deduped };
}

interface MutableUnit {
  key: string;
  title: string;
  checked: boolean;
  range: SourceRange;
  dependenciesRange?: SourceRange;
  dependencies: UnitDependencies;
  criteria: CriteriaField[];
}

/**
 * Parses `## Implementation Units` markers and their fields from `document`.
 * See {@link UnitsParseResult} for the duplicate-key exclusion contract:
 * excluded units are absent from `units`, not merely flagged, and their
 * dependents are separately flagged as `unknown-dependency`. `document` is
 * read only — its source is never modified.
 */
export function parseUnits(document: PlanDocument): UnitsParseResult {
  const source = document.source;
  const lines = splitLines(source);
  const mask = computeMask(source, lines);
  const issues: UnitsIssue[] = [];

  let sectionStart = -1;
  for (let i = 0; i < lines.length; i++) {
    if (mask[i]) continue;
    const content = lines[i]?.content ?? "";
    const forMatch = i === 0 ? content.replace(/^\uFEFF/, "") : content;
    if (SECTION_HEADING_RE.test(forMatch)) {
      sectionStart = i;
      break;
    }
  }

  if (sectionStart < 0) {
    issues.push({
      kind: "missing-section",
      message: "no '## Implementation Units' section found",
    });
    return { units: [], issues };
  }

  let sectionEnd = lines.length;
  for (let i = sectionStart + 1; i < lines.length; i++) {
    if (mask[i]) continue;
    if (ANY_H1_H2_RE.test(lines[i]?.content ?? "")) {
      sectionEnd = i;
      break;
    }
  }

  const candidates = findMarkerCandidates(
    lines,
    mask,
    sectionStart + 1,
    sectionEnd,
  );

  for (const candidate of candidates) {
    if (!candidate.wellFormed) {
      const line = lines[candidate.lineIndex];
      issues.push({
        kind: "malformed-marker",
        message: "unit marker does not match the required grammar",
        range: line ? { start: line.start, end: line.end } : undefined,
      });
    }
  }

  const wellFormed = candidates.filter((c) => c.wellFormed);
  const seen = new Map<string, MarkerCandidate[]>();
  for (const candidate of wellFormed) {
    const key = candidate.key ?? "";
    const list = seen.get(key) ?? [];
    list.push(candidate);
    seen.set(key, list);
  }

  const duplicateKeys = new Set<string>();
  for (const [key, list] of seen) {
    if (list.length > 1) {
      duplicateKeys.add(key);
      for (const dup of list) {
        const line = lines[dup.lineIndex];
        issues.push({
          kind: "duplicate-key",
          message: `unit key '${key}' is declared more than once`,
          unitKey: key,
          range: line ? { start: line.start, end: line.end } : undefined,
        });
      }
    }
  }

  const unitEntries: MutableUnit[] = [];
  for (let idx = 0; idx < candidates.length; idx++) {
    const candidate = candidates[idx];
    if (!candidate?.wellFormed) continue;
    const key = candidate.key ?? "";
    if (duplicateKeys.has(key)) continue;

    const nextCandidateLine = candidates[idx + 1]?.lineIndex ?? sectionEnd;
    const startLine = lines[candidate.lineIndex];
    const endOffset = lines[nextCandidateLine]?.start ?? source.length;

    const unit: MutableUnit = {
      key,
      title: candidate.title ?? "",
      checked: candidate.checked ?? false,
      range: { start: startLine?.start ?? 0, end: endOffset },
      dependencies: { kind: "invalid", reason: "no Dependencies field found" },
      criteria: [],
    };

    for (let i = candidate.lineIndex + 1; i < nextCandidateLine; i++) {
      if (mask[i]) continue;
      const content = lines[i]?.content ?? "";
      const fieldMatch = FIELD_LABEL_RE.exec(content);
      if (!fieldMatch) continue;
      const label = fieldMatch[1] as string;
      const { afterLabel, end } = findFieldRange(
        lines,
        mask,
        i,
        nextCandidateLine,
      );
      const range: SourceRange = { start: afterLabel, end };

      if (label === "Dependencies") {
        unit.dependenciesRange = range;
        const inlineText = fieldMatch[2] ?? "";
        const fullText = `${inlineText}\n${source.slice(
          lines[i]?.end ?? afterLabel,
          end,
        )}`;
        unit.dependencies = parseDependenciesText(fullText.replace(/\n/g, " "));
      } else if (CRITERIA_LABELS.has(label)) {
        unit.criteria.push({ label: label as CriteriaLabel, range });
      }
    }

    unitEntries.push(unit);
  }

  for (const unit of unitEntries) {
    if (
      unit.dependencies.kind === "keys" &&
      unit.dependencies.keys.includes(unit.key)
    ) {
      issues.push({
        kind: "self-dependency",
        message: `unit '${unit.key}' cannot depend on itself`,
        unitKey: unit.key,
        range: unit.dependenciesRange,
      });
      unit.dependencies = { kind: "invalid", reason: "self-dependency" };
    }
  }

  for (const unit of unitEntries) {
    // Distinguish the ambiguous-range invalid reason from other invalid
    // reasons (missing/self/unknown) already reported with their own kind.
    if (
      unit.dependencies.kind === "invalid" &&
      unit.dependencies.reason ===
        "ambiguous dependency range must not be expanded"
    ) {
      issues.push({
        kind: "ambiguous-dependency-range",
        message: `unit '${unit.key}' declares an ambiguous dependency range`,
        unitKey: unit.key,
        range: unit.dependenciesRange,
      });
    }
  }

  const knownKeys = new Set(unitEntries.map((u) => u.key));
  for (const unit of unitEntries) {
    if (unit.dependencies.kind !== "keys") continue;
    const unknown = unit.dependencies.keys.filter((k) => !knownKeys.has(k));
    if (unknown.length > 0) {
      issues.push({
        kind: "unknown-dependency",
        message: `unit '${unit.key}' depends on unknown key(s): ${unknown.join(", ")}`,
        unitKey: unit.key,
        range: unit.dependenciesRange,
      });
      unit.dependencies = { kind: "invalid", reason: "unknown-dependency" };
    }
  }

  // Cycle detection over the remaining "keys"-kind edges.
  const byKey = new Map(unitEntries.map((u) => [u.key, u] as const));
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const inCycle = new Set<string>();

  // Explicit frames avoid call-stack limits on deep chains. Only the active
  // path segment reached by a back-edge is marked as cyclic, not its dependents.
  interface Frame {
    key: string;
    deps: readonly string[];
    nextDepIndex: number;
  }

  function pushFrame(key: string, activePath: string[], frames: Frame[]): void {
    color.set(key, GRAY);
    activePath.push(key);
    const unit = byKey.get(key);
    const deps =
      unit?.dependencies.kind === "keys" ? unit.dependencies.keys : [];
    frames.push({ key, deps, nextDepIndex: 0 });
  }

  function visitFrom(rootKey: string): void {
    const activePath: string[] = [];
    const frames: Frame[] = [];
    pushFrame(rootKey, activePath, frames);

    while (frames.length > 0) {
      const frame = frames[frames.length - 1] as Frame;
      if (frame.nextDepIndex < frame.deps.length) {
        const dep = frame.deps[frame.nextDepIndex] as string;
        frame.nextDepIndex++;
        const depColor = color.get(dep) ?? WHITE;
        if (depColor === WHITE) {
          pushFrame(dep, activePath, frames);
        } else if (depColor === GRAY) {
          const cycleStart = activePath.indexOf(dep);
          for (const k of activePath.slice(cycleStart)) inCycle.add(k);
        }
      } else {
        activePath.pop();
        color.set(frame.key, BLACK);
        frames.pop();
      }
    }
  }

  for (const key of byKey.keys()) {
    if ((color.get(key) ?? WHITE) === WHITE) visitFrom(key);
  }

  if (inCycle.size > 0) {
    issues.push({
      kind: "dependency-cycle",
      message: `dependency cycle among units: ${Array.from(inCycle).sort().join(", ")}`,
    });
    for (const key of inCycle) {
      const unit = byKey.get(key);
      if (unit)
        unit.dependencies = { kind: "invalid", reason: "dependency-cycle" };
    }
  }

  const units: ParsedUnit[] = unitEntries.map((u) => Object.freeze({ ...u }));
  return { units: Object.freeze(units), issues: Object.freeze(issues) };
}
