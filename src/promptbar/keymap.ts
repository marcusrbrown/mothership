/**
 * Pure Enter-vs-Shift+Enter decision, extracted from the Tiptap
 * keymap so the submit-vs-newline contract can be unit-tested without
 * mounting an editor: Enter alone submits, Shift+Enter inserts a newline.
 * Any other modifier combination (Cmd/Ctrl/Alt+Enter) also newlines — only
 * a bare Enter submits.
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
