import { DockviewReact, type DockviewReadyEvent } from "dockview-react";
/**
 * DockviewReact wrapper: components sourced from the panel registry,
 * onReady constructs the real adapter + wires the executor, themed via
 * mothership-dockview (dockview-theme.css, tokens only). Seeds the default
 * first-open layout (roster left / sessions+transcript tabbed center /
 * terminal bottom / audit-log drawer) with placeholders — saved layout wins.
 */
import { useCallback, useRef } from "react";
import "./dockview-theme.css";
import type { BusContext } from "../server/types";
import type { DockviewAdapter } from "./adapter";
import { createDockviewAdapter } from "./dockview-adapter";
import { executeCommand } from "./executor";
import { loadLayout, saveLayout } from "./persistence";
import { panelComponents } from "./registry";

export interface DockviewShellProps {
  /** Absolute workspace path — the persistence key. */
  workspacePath: string;
  /** Live BusContext for the roster/sessions panels; absent → those panels
   * render their own config-missing error state (no crash). */
  context?: BusContext;
}

function seedDefaultLayout(
  adapter: DockviewAdapter,
  context: BusContext | undefined,
): void {
  const firstProjectName = context?.roster.projects[0]?.name;

  executeCommand(
    {
      type: "open_panel",
      panelId: "roster",
      panelType: "roster",
      params: { context, onSelectProject: undefined },
    },
    adapter,
  );
  executeCommand(
    {
      type: "split",
      panelId: "sessions",
      panelType: "sessions",
      referencePanelId: "roster",
      direction: "right",
      params: { context, projectName: firstProjectName },
    },
    adapter,
  );
  executeCommand(
    {
      type: "split",
      panelId: "transcript",
      panelType: "placeholder",
      referencePanelId: "sessions",
      direction: "right",
      params: { panelType: "transcript" },
    },
    adapter,
  );
  executeCommand(
    {
      type: "split",
      panelId: "terminal",
      panelType: "terminal",
      referencePanelId: "sessions",
      direction: "down",
      params: {},
    },
    adapter,
  );
  executeCommand(
    {
      type: "split",
      panelId: "audit-log",
      panelType: "placeholder",
      referencePanelId: "transcript",
      direction: "down",
      params: { panelType: "audit-log" },
    },
    adapter,
  );
}

export function DockviewShell({ workspacePath, context }: DockviewShellProps) {
  const adapterRef = useRef<DockviewAdapter | undefined>(undefined);

  const handleReady = useCallback(
    (event: DockviewReadyEvent) => {
      const adapter = createDockviewAdapter(event.api);
      adapterRef.current = adapter;

      const saved = loadLayout(workspacePath);
      if (saved) {
        executeCommand({ type: "set_layout", layout: saved }, adapter);
      } else {
        seedDefaultLayout(adapter, context);
      }

      event.api.onDidLayoutChange(() => {
        saveLayout(workspacePath, adapter.toJSON());
      });
    },
    [workspacePath, context],
  );

  return (
    <DockviewReact
      className="mothership-dockview"
      components={panelComponents()}
      onReady={handleReady}
    />
  );
}
