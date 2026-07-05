/**
 * Registers built-in panel types on module load. Import this once from the
 * app entrypoint before mounting DockviewShell. Real panel types (roster,
 * sessions, transcript, terminal, ...) register themselves here as they land
 * in later units.
 */
import { AuditLogPanel } from "../panels/audit-log";
import { PlaceholderPanel } from "../panels/placeholder";
import { RosterPanel } from "../panels/roster";
import { SessionsPanel } from "../panels/sessions";
import { TerminalPanel } from "../panels/terminal";
import { TranscriptPanel } from "../panels/transcript";
import { registerPanelType } from "./registry";

registerPanelType("placeholder", {
  component: PlaceholderPanel,
  title: "Placeholder",
});

registerPanelType("terminal", {
  component: TerminalPanel,
  title: "Terminal",
  // Terminal mounts a real shell via pty_spawn — ide_* (mcp_tool-origin)
  // commands must never be able to reach it (see executor.ts enforcement).
  mcpOpenable: false,
});

registerPanelType("roster", {
  component: RosterPanel,
  title: "Roster",
});

registerPanelType("sessions", {
  component: SessionsPanel,
  title: "Sessions",
});

registerPanelType("transcript", {
  component: TranscriptPanel,
  title: "Transcript",
});

registerPanelType("audit-log", {
  component: AuditLogPanel,
  title: "Audit Log",
});
