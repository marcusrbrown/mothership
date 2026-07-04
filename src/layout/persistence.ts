/**
 * Save/load a serialized layout keyed by workspace path (localStorage).
 * Restore referencing an unregistered panel type substitutes the placeholder
 * panel type and continues hydration rather than throwing.
 */
import type { SerializedLayout } from "./commands";
import { hasPanelType } from "./registry";

const KEY_PREFIX = "mothership:layout:";

/**
 * The real webview always has `localStorage`. This in-memory fallback exists
 * only so persistence logic is unit-testable outside a DOM (bun test has no
 * Storage global) — never used in the app itself.
 */
function memoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => store.clear(),
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  };
}

const storage: Storage =
  typeof localStorage === "undefined" ? memoryStorage() : localStorage;

function storageKey(workspacePath: string): string {
  return `${KEY_PREFIX}${workspacePath}`;
}

export function saveLayout(
  workspacePath: string,
  layout: SerializedLayout,
): void {
  storage.setItem(storageKey(workspacePath), JSON.stringify(layout));
}

/**
 * Load a persisted layout for the given workspace path, if any. Returns
 * `undefined` when nothing is saved or the saved value can't be parsed.
 * Any panel referencing an unregistered type is rewritten to the
 * `placeholder` panel type (with the original type preserved in params)
 * so hydration always succeeds.
 */
export function loadLayout(
  workspacePath: string,
): SerializedLayout | undefined {
  const raw = storage.getItem(storageKey(workspacePath));
  if (!raw) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }

  if (typeof parsed !== "object" || parsed === null) return undefined;

  return substituteUnregisteredPanelTypes(parsed as SerializedLayout);
}

export function clearLayout(workspacePath: string): void {
  storage.removeItem(storageKey(workspacePath));
}

/** Test-only escape hatch to write raw (possibly malformed) persisted data. */
export function __setStorageItemForTests(
  workspacePath: string,
  raw: string,
): void {
  storage.setItem(storageKey(workspacePath), raw);
}

interface PersistedPanel {
  panelType?: string;
  params?: Record<string, unknown>;
  [key: string]: unknown;
}

function substituteUnregisteredPanelTypes(
  layout: SerializedLayout,
): SerializedLayout {
  const panels = (layout as { panels?: Record<string, PersistedPanel> }).panels;
  if (!panels || typeof panels !== "object") return layout;

  const nextPanels: Record<string, PersistedPanel> = {};
  for (const [id, panel] of Object.entries(panels)) {
    if (panel.panelType && !hasPanelType(panel.panelType)) {
      nextPanels[id] = {
        ...panel,
        panelType: "placeholder",
        params: { ...panel.params, panelType: panel.panelType },
      };
    } else {
      nextPanels[id] = panel;
    }
  }

  return { ...layout, panels: nextPanels };
}
