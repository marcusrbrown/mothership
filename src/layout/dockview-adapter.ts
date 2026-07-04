/**
 * Real DockviewAdapter implementation over dockview-core's DockviewApi.
 * The only file that translates our `SplitDirection` vocabulary into
 * dockview-core's positional types.
 *
 * dockview-react 7.x notes (see docs/solutions/integration-issues/
 * tauri-dragdrop-swallows-dockview-dnd-2026-07-04.md):
 * - `addPanel`'s `position.direction` uses dockview-core's `Direction`
 *   ('left'|'right'|'above'|'below'|'within'), NOT `Position`.
 * - Panel-level `moveTo` (IDockviewPanel.api.moveTo) takes a `Position`
 *   ('center'|'top'|'bottom'|'left'|'right'), not `Direction` — used here
 *   for `move_panel` since we're moving an existing panel, not adding one.
 */
import type { DockviewApi } from "dockview-core";
import type { Direction } from "dockview-core";
import type {
  AdapterPanelInfo,
  AddPanelSpec,
  DockviewAdapter,
  MovePanelSpec,
} from "./adapter";
import type { SerializedLayout, SplitDirection } from "./commands";

const DIRECTION_TO_DOCKVIEW: Record<SplitDirection, Direction> = {
  left: "left",
  right: "right",
  up: "above",
  down: "below",
};

const DIRECTION_TO_POSITION: Record<
  SplitDirection,
  "left" | "right" | "top" | "bottom"
> = {
  left: "left",
  right: "right",
  up: "top",
  down: "bottom",
};

export function createDockviewAdapter(api: DockviewApi): DockviewAdapter {
  return {
    get panels(): AdapterPanelInfo[] {
      return api.panels.map((p) => ({
        id: p.id,
        panelType: p.view.contentComponent,
      }));
    },

    get activePanel(): AdapterPanelInfo | undefined {
      const p = api.activePanel;
      return p ? { id: p.id, panelType: p.view.contentComponent } : undefined;
    },

    hasPanel(id: string): boolean {
      return api.getPanel(id) !== undefined;
    },

    addPanel(spec: AddPanelSpec): void {
      api.addPanel({
        id: spec.id,
        component: spec.panelType,
        title: spec.title,
        params: spec.params,
        position: spec.position
          ? {
              referencePanel: spec.position.referencePanelId,
              direction: DIRECTION_TO_DOCKVIEW[spec.position.direction],
            }
          : undefined,
      });
    },

    removePanel(id: string): void {
      const panel = api.getPanel(id);
      if (panel) api.removePanel(panel);
    },

    movePanel(spec: MovePanelSpec): void {
      const panel = api.getPanel(spec.id);
      const referencePanel = api.getPanel(spec.referencePanelId);
      if (!panel || !referencePanel) return;
      panel.api.moveTo({
        group: referencePanel.group,
        position: DIRECTION_TO_POSITION[spec.direction],
      });
    },

    focus(id: string): void {
      const panel = api.getPanel(id);
      panel?.api.setActive();
    },

    toJSON(): SerializedLayout {
      return api.toJSON() as unknown as SerializedLayout;
    },

    fromJSON(layout: SerializedLayout): void {
      api.fromJSON(layout as never);
    },
  };
}
