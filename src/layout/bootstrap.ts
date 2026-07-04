/**
 * Registers built-in panel types on module load. Import this once from the
 * app entrypoint before mounting DockviewShell. Real panel types (roster,
 * sessions, transcript, terminal, ...) register themselves here as they land
 * in later units.
 */
import { PlaceholderPanel } from "../panels/placeholder";
import { registerPanelType } from "./registry";

registerPanelType("placeholder", {
  component: PlaceholderPanel,
  title: "Placeholder",
});
