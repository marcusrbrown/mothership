import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { BridgeResponse } from "../../src/layout/bridge-protocol";
import { openPanelCommandSchema } from "../../src/layout/commands";
import { createIdeMcpServer } from "./mcp-server";
import type { WsBridge } from "./ws-bridge";

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
      domain: "layout",
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
        domain: "layout",
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
    if (res.ok && res.domain === "layout") {
      expect(res.layout).toEqual({ panels: { p1: { id: "p1" } } });
    } else {
      throw new Error("expected ok:true domain:layout response");
    }
  });

  test("an unavailable bridge relay is a typed error, not a hang", async () => {
    const bridge = stubBridge(async () => ({
      kind: "response",
      domain: "transport",
      seq: 0,
      ok: false,
      error: {
        code: "unavailable",
        message: "no webview client connected",
        delivery: "not_sent",
      },
    }));
    createIdeMcpServer(bridge);
    const res = await bridge.dispatch("ide_focus", {
      type: "focus",
      panelId: "x",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("unavailable");
    }
  });
});

describe("layout relay paths reject non-layout success shapes (domain narrowing)", () => {
  const NON_LAYOUT_PARAMS = { params: { context: { secret: "s3cr3t" } } };

  test("relayMutation: a domain:session ok:true response is a stable typed MCP error, not misread as layout", async () => {
    const bridge = stubBridge(async () => ({
      kind: "response",
      domain: "session",
      seq: 1,
      ok: true,
      data: NON_LAYOUT_PARAMS,
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
      name: "ide_focus",
      arguments: { type: "focus", panelId: "x" },
    });
    const text = (result.content as { type: string; text: string }[])[0]?.text;
    expect(result.isError).toBe(true);
    expect(text).toBeDefined();
    // No leakage of the mismatched domain's raw payload.
    expect(text).not.toContain("s3cr3t");
    expect(text).not.toContain("context");
    const parsed = JSON.parse(text ?? "{}") as {
      error?: { code?: string; message?: string };
    };
    expect(parsed.error?.code).toBeDefined();
    expect(typeof parsed.error?.message).toBe("string");

    await client.close();
  });

  test("relayListPanels: a domain:transport ok:false response is relayed as a typed error, never an empty-success fallback", async () => {
    const bridge = stubBridge(async () => ({
      kind: "response",
      domain: "transport",
      seq: 1,
      ok: false,
      error: {
        code: "timeout",
        message: "request 1 timeout",
        delivery: "indeterminate",
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
      name: "ide_list_panels",
      arguments: {},
    });
    const text = (result.content as { type: string; text: string }[])[0]?.text;
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(text ?? "{}") as {
      error?: { code?: string };
      panels?: unknown;
    };
    expect(parsed.error?.code).toBe("timeout");
    expect(parsed.panels).toBeUndefined();

    await client.close();
  });

  test("relayGetLayout: a domain:session ok:true response is a stable typed MCP error, not misread as layout", async () => {
    const bridge = stubBridge(async () => ({
      kind: "response",
      domain: "session",
      seq: 1,
      ok: true,
      data: NON_LAYOUT_PARAMS,
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
      name: "ide_get_layout",
      arguments: {},
    });
    const text = (result.content as { type: string; text: string }[])[0]?.text;
    expect(result.isError).toBe(true);
    expect(text).not.toContain("s3cr3t");
    expect(text).not.toContain("context");
    const parsed = JSON.parse(text ?? "{}") as {
      error?: { code?: string };
      layout?: unknown;
    };
    expect(parsed.error?.code).toBeDefined();
    expect(parsed.layout).toBeUndefined();

    await client.close();
  });
});

describe("mutation results are redacted (disclosure boundary parity with reads)", () => {
  test("a mutation tool result never contains credential-bearing params", async () => {
    const SECRET = "sup3r-s3cret-password";
    const bridge = stubBridge(async () => ({
      kind: "response",
      domain: "layout",
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
