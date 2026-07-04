import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles/tokens.css";

// Spike harness: `bun run dev` + ?spike=<id> mounts spikes/<id>-*/index.tsx
// in the real shell (HANDOFF Phase 0). No spike code ships in the app path.
const spikeId = new URLSearchParams(window.location.search).get("spike");
const spikes = import.meta.glob<{ default: React.ComponentType }>(
  "../spikes/*/index.tsx",
);

async function mount() {
  const root = ReactDOM.createRoot(
    document.getElementById("root") as HTMLElement,
  );
  if (spikeId) {
    const key = Object.keys(spikes).find((path) =>
      path.includes(`/spikes/${spikeId}-`),
    );
    if (key) {
      const { default: Spike } = await spikes[key]();
      root.render(<Spike />);
      return;
    }
    console.error(`spike "${spikeId}" not found; available:`, spikes);
  }
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

void mount();
