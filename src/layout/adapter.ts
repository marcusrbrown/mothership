/**
 * The narrow surface the executor sees. This is the ONLY interface that touches
 * dockview's imperative API (real implementation: dockview-adapter.ts). Tests
 * exercise the executor against a stub implementing this same interface.
 */
import type { SplitDirection } from "./commands";
import type { SerializedLayout } from "./commands";

export interface AdapterPanelInfo {
  id: string;
  panelType: string;
}

export interface AddPanelSpec {
  id: string;
  panelType: string;
  title?: string;
  params?: Record<string, unknown>;
  position?: {
    referencePanelId: string;
    direction: SplitDirection;
  };
}

export interface MovePanelSpec {
  id: string;
  referencePanelId: string;
  direction: SplitDirection;
}

/**
 * Adapter contract the executor drives. Implementations own translating
 * `SplitDirection` ('left'|'right'|'up'|'down') into whatever positional
 * vocabulary the underlying chassis uses.
 */
export interface DockviewAdapter {
  readonly panels: AdapterPanelInfo[];
  readonly activePanel: AdapterPanelInfo | undefined;
  addPanel(spec: AddPanelSpec): void;
  removePanel(id: string): void;
  movePanel(spec: MovePanelSpec): void;
  focus(id: string): void;
  toJSON(): SerializedLayout;
  fromJSON(layout: SerializedLayout): void;
  hasPanel(id: string): boolean;
}
