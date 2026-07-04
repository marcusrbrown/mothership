/**
 * Pure Enter-vs-Shift+Enter decision (U1.6), extracted from the Tiptap
 * keymap so the submit-vs-newline contract can be unit-tested without
 * mounting an editor. Mirrors the plain bar's `onKeyDown` semantics
 * (U1.5): Enter alone submits, Shift+Enter inserts a newline. Any other
 * modifier combination (Cmd/Ctrl/Alt+Enter) also newlines — only a bare
 * Enter submits, matching the plain bar exactly.
 */
export interface KeyChord {
  key: string;
  shiftKey: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
}

export type KeymapAction = "submit" | "newline" | "ignore";

export function decideEnterAction(chord: KeyChord): KeymapAction {
  if (chord.key !== "Enter") return "ignore";
  if (chord.shiftKey || chord.metaKey || chord.ctrlKey || chord.altKey) {
    return "newline";
  }
  return "submit";
}
