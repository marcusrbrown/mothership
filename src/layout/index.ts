/**
 * Stable module API — the MCP bridge and panels import from here
 * only. Do not deep-import from adapter.ts / registry.ts / executor.ts
 * outside this package.
 */
export {
  layoutCommandSchema,
  openPanelCommandSchema,
  closePanelCommandSchema,
  splitCommandSchema,
  focusCommandSchema,
  movePanelCommandSchema,
  setLayoutCommandSchema,
  splitDirectionSchema,
} from "./commands";
export type {
  LayoutCommand,
  OpenPanelCommand,
  ClosePanelCommand,
  SplitCommand,
  FocusCommand,
  MovePanelCommand,
  SetLayoutCommand,
  SplitDirection,
  CommandResult,
  CommandSource,
  LayoutError,
  LayoutErrorCode,
  SerializedLayout,
} from "./commands";

export { executeCommand, onCommandExecuted } from "./executor";
export type { CommandExecutedEvent } from "./executor";

export {
  registerPanelType,
  getPanelType,
  hasPanelType,
  listPanelTypes,
  panelComponents,
} from "./registry";
export type { PanelRegistration } from "./registry";

export { saveLayout, loadLayout, clearLayout } from "./persistence";

export { DockviewShell } from "./DockviewShell";
export type { DockviewShellProps } from "./DockviewShell";

export { createDockviewAdapter } from "./dockview-adapter";
export type {
  DockviewAdapter,
  AddPanelSpec,
  MovePanelSpec,
  AdapterPanelInfo,
} from "./adapter";
