/**
 * Pure @-mention suggestion sourcing + filtering (U1.6). Kept DOM-free so it
 * can be unit-tested directly — the Tiptap `suggestion` plugin's `items()`
 * callback is a thin wrapper around `filterMentionItems`.
 *
 * Sources: workspace roster projects (`BusContext.roster.projects`) always;
 * live sessions (`SessionStore`) when a store + directory are threaded in
 * from the mount site (see PromptBar's optional `store`/`directory` props).
 * If no store is available, @-session mentions are simply absent from the
 * suggestion list — degradation, not an error.
 */
import type { SessionStore } from "../server/session-store";
import type { BusContext } from "../server/types";

export type MentionKind = "project" | "session";

export interface MentionItem {
  /** Stable id the mention node stores — project name or session id. */
  id: string;
  /** Display label — what gets rendered as `@label` in suggestions and text. */
  label: string;
  kind: MentionKind;
}

/** Builds the full (unfiltered) mention item list from the workspace roster
 * and, optionally, the live session store for a given project directory. */
export function buildMentionItems(
  context: BusContext | undefined,
  store?: SessionStore,
  directory?: string,
): MentionItem[] {
  const items: MentionItem[] = [];

  for (const project of context?.roster.projects ?? []) {
    items.push({ id: project.name, label: project.name, kind: "project" });
  }

  if (store) {
    for (const session of store.getSessions(directory)) {
      items.push({
        id: session.id,
        label: session.title ?? session.id,
        kind: "session",
      });
    }
  }

  return items;
}

/** Case-insensitive substring filter over label — the suggestion popup's
 * `items()` callback. Empty query returns everything. */
export function filterMentionItems(
  items: MentionItem[],
  query: string,
): MentionItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter((item) => item.label.toLowerCase().includes(q));
}
