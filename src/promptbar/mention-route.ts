/**
 * Pure "which project should this dispatch route to" resolution, extracted
 * from PromptBar.tsx so it's unit-testable without mounting Tiptap.
 *
 * Two sources, in priority order:
 * 1. A real mention NODE in the doc naming a roster project (the normal
 *    path: the user picked a suggestion from the popup).
 * 2. A LEADING plain-text `@word` at the very start of the serialized
 *    prompt (bug A′): the user typed through the mention suggestion
 *    without selecting it, so no mention node exists, but the text still
 *    reads like a routing mention (e.g. "@dashboard summarize…"). Only
 *    the leading token is scanned — a mid-text "@foo" (e.g. inside an
 *    email address or an aside) never routes, to avoid false positives.
 */
import type { BusContext } from "../server/types";
import type { JSONDoc } from "./serialize";

/** Roster project names are often `org/repo` (e.g. "fro-bot/dashboard").
 * Users may type just the repo segment ("@dashboard") — match against
 * both the full name and its last path segment. */
function projectBaseName(name: string): string {
  const idx = name.lastIndexOf("/");
  return idx === -1 ? name : name.slice(idx + 1);
}

/** Finds the first mention node in the doc whose id/label matches a roster
 * project name. Returns undefined if there's no mention or none of them
 * name a real project. */
export function firstMentionedProject(
  doc: JSONDoc,
  context: BusContext,
): string | undefined {
  const projectNames = new Set(context.roster.projects.map((p) => p.name));

  function walk(nodes: JSONDoc["content"]): string | undefined {
    for (const node of nodes ?? []) {
      if (node.type === "mention") {
        const candidate = node.attrs?.id ?? node.attrs?.label;
        if (candidate && projectNames.has(candidate)) return candidate;
      }
      const found = walk(node.content);
      if (found) return found;
    }
    return undefined;
  }

  return walk(doc.content);
}

/** Scans ONLY the leading `@word` of the (trimmed) serialized prompt text
 * for a roster project name — case-insensitive, matched against both the
 * full project name and its last path segment. Returns undefined when
 * there's no leading `@word` or it doesn't name a real project. Does NOT
 * scan mid-text `@`s (e.g. "email me at foo@bar.com" never routes). */
export function leadingPlainTextMentionProject(
  text: string,
  context: BusContext,
): string | undefined {
  // `[\w-/]` (not just `[\w-]`) so roster project names with an org/repo
  // slash (e.g. "fro-bot/dashboard") can be typed in full, not just their
  // last path segment.
  const match = /^@([\w\-/]+)\b/.exec(text.trim());
  if (!match) return undefined;
  const token = match[1]?.toLowerCase();
  if (!token) return undefined;

  const project = context.roster.projects.find(
    (p) =>
      p.name.toLowerCase() === token ||
      projectBaseName(p.name).toLowerCase() === token,
  );
  return project?.name;
}

/** Combined resolution: mention NODE wins when present (even if a leading
 * plain-text `@word` also exists); otherwise falls back to the leading
 * plain-text scan. */
export function resolveMentionedProject(
  doc: JSONDoc,
  text: string,
  context: BusContext,
): string | undefined {
  return (
    firstMentionedProject(doc, context) ??
    leadingPlainTextMentionProject(text, context)
  );
}
