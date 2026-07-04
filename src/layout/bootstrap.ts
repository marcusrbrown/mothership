/**
 * Registers built-in panel types on module load. Import this once from the
 * app entrypoint before mounting DockviewShell. Real panel types (roster,
 * sessions, transcript, terminal, ...) register themselves here as they land
 * in later units.
 */
import { PlaceholderPanel } from "../panels/placeholder";
import { RosterPanel } from "../panels/roster";
import { SessionsPanel } from "../panels/sessions";
import { TerminalPanel } from "../panels/terminal";
import { registerPanelType } from "./registry";

registerPanelType("placeholder", {
  component: PlaceholderPanel,
  title: "Placeholder",
});

registerPanelType("terminal", {
  component: TerminalPanel,
  title: "Terminal",
});

registerPanelType("roster", {
  component: RosterPanel,
  title: "Roster",
});

registerPanelType("sessions", {
  component: SessionsPanel,
  title: "Sessions",
});
