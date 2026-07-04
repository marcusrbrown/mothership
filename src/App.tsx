const spikes = import.meta.env.DEV
  ? [
      { id: "0a", label: "0a — iframe stress" },
      { id: "0b", label: "0b — PTY" },
      { id: "0c", label: "0c — server connectivity" },
    ]
  : [];

function App() {
  return (
    <main
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-4)",
        alignItems: "center",
        justifyContent: "center",
        height: "100vh",
        background: "var(--color-bg)",
        color: "var(--color-text)",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <h1 style={{ color: "var(--color-text-secondary)" }}>Mothership</h1>
      {spikes.length > 0 && (
        <nav style={{ display: "flex", gap: "var(--space-2)" }}>
          {spikes.map((s) => (
            <a
              key={s.id}
              href={`/?spike=${s.id}`}
              style={{
                color: "var(--color-accent)",
                border: "1px solid var(--color-border)",
                borderRadius: "var(--radius-sm)",
                padding: "var(--space-1) var(--space-2)",
                textDecoration: "none",
                fontSize: "var(--text-sm)",
              }}
            >
              {s.label}
            </a>
          ))}
        </nav>
      )}
    </main>
  );
}

export default App;
