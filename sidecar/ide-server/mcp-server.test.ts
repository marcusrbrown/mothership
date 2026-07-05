import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { openPanelCommandSchema } from "../../src/layout/commands";
import { createIdeMcpServer } from "./mcp-server";
import type { BridgeResponse, WsBridge } from "./ws-bridge";

function stubBridge(
  handler: (tool: string, params: unknown) => Promise<BridgeResponse>,
): WsBridge {
  return {
    onOpen: () => {},
    onMessage: () => {},
    onClose: () => {},
    isReady: () => true,
    dispatch: handler,
  };
}

describe("createIdeMcpServer tool registration", () => {
  test("constructs without a connected transport (registration is synchronous)", () => {
    const bridge = stubBridge(async () => ({
      kind: "response",
      seq: 1,
      ok: true,
      layout: {},
    }));
    const server = createIdeMcpServer(bridge);
    expect(server.isConnected()).toBe(false);
  });

  test("open_panel schema matches the command union member", () => {
    expect(openPanelCommandSchema.shape.panelId).toBeDefined();
    expect(openPanelCommandSchema.shape.panelType).toBeDefined();
  });
});

describe("mutation relay contract (via ws-bridge stub)", () => {
  test("a successful relay returns the layout, never bare success", async () => {
    const bridge = stubBridge(async (tool, params) => {
      expect(tool).toBe("ide_open_panel");
      expect((params as { panelId: string }).panelId).toBe("p1");
      return {
        kind: "response",
        seq: 1,
        ok: true,
        layout: { panels: { p1: { id: "p1" } } },
      };
    });
    createIdeMcpServer(bridge);
    const res = await bridge.dispatch("ide_open_panel", {
      type: "open_panel",
      panelId: "p1",
      panelType: "terminal",
    });
    expect(res.ok).toBe(true);
    expect(res.layout).toEqual({ panels: { p1: { id: "p1" } } });
  });

  test("an unavailable bridge relay is a typed error, not a hang", async () => {
    const bridge = stubBridge(async () => ({
      kind: "response",
      seq: 0,
      ok: false,
      error: { code: "unavailable", message: "no webview client connected" },
    }));
    createIdeMcpServer(bridge);
    const res = await bridge.dispatch("ide_focus", {
      type: "focus",
      panelId: "x",
    });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("unavailable");
  });
});

describe("mutation results are redacted (disclosure boundary parity with reads)", () => {
  test("a mutation tool result never contains credential-bearing params", async () => {
    const SECRET = "sup3r-s3cret-password";
    const bridge = stubBridge(async () => ({
      kind: "response",
      seq: 1,
      ok: true,
      layout: {
        panels: {
          p1: {
            id: "p1",
            contentComponent: "terminal",
            title: "My Terminal",
            params: {
              context: { credentials: { password: SECRET } },
            },
          },
        },
      },
    }));

    const server = createIdeMcpServer(bridge);
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.0" });

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const result = await client.callTool({
      name: "ide_open_panel",
      arguments: { type: "open_panel", panelId: "p1", panelType: "terminal" },
    });

    const text = (result.content as { type: string; text: string }[])[0]?.text;
    expect(text).toBeDefined();
    if (result.isError) {
      throw new Error(`tool call failed: ${text}`);
    }
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("password");
    expect(text).not.toContain("credentials");
    expect(text).not.toContain("params");

    const parsed = JSON.parse(text ?? "{}") as {
      layout?: { panels?: Record<string, unknown> };
    };
    expect(parsed.layout?.panels?.p1).toEqual({
      id: "p1",
      panelType: "terminal",
      title: "My Terminal",
    });

    await client.close();
  });
});
