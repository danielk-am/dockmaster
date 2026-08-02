import { createServer } from "node:http";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { toNodeHandler } from "@modelcontextprotocol/node";
import {
  createMcpHandler,
  McpServer,
  validateHostHeader,
} from "@modelcontextprotocol/server";
import { z } from "zod";

const MODERN_VERSION = "2026-07-28";
const host = process.env.NODE_MCP_HOST ?? "127.0.0.1";
const port = parsePort(process.env.NODE_MCP_PORT ?? "8787");
const bearerSecret = requiredSecret("NODE_MCP_BEARER_SECRET");
const allowedHosts = requiredList("NODE_MCP_ALLOWED_HOSTS");
const allowedOrigins = new Set(
  requiredList("NODE_MCP_ALLOWED_ORIGINS").map(normalizeOrigin),
);
const memory = {
  value: null,
  revision: 0,
  previousValue: null,
  canUndo: false,
};

const stateSchema = z.object({
  value: z.string().nullable(),
  revision: z.number().int().nonnegative(),
});
const changeInputSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("set"), value: z.string().max(256) }),
  z.object({ operation: z.literal("undo") }),
]);
const changeOutputSchema = stateSchema.extend({ changed: z.boolean() });

function parsePort(value) {
  if (!/^\d+$/.test(value)) {
    throw new Error("NODE_MCP_PORT must be an integer between 0 and 65535");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 65_535) {
    throw new Error("NODE_MCP_PORT must be an integer between 0 and 65535");
  }
  return parsed;
}

function requiredSecret(name) {
  const value = process.env[name];
  if (!value || value.length < 16 || /\s/.test(value)) {
    throw new Error(`${name} must be at least 16 non-whitespace characters`);
  }
  return value;
}

function requiredList(name) {
  const values = (process.env[name] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (values.length === 0) {
    throw new Error(`${name} must contain at least one value`);
  }
  return values;
}

function normalizeOrigin(value) {
  const origin = new URL(value);
  if (!/^https?:$/.test(origin.protocol) || value !== origin.origin) {
    throw new Error(
      "NODE_MCP_ALLOWED_ORIGINS entries must be exact HTTP(S) origins",
    );
  }
  return origin.origin;
}

function isAllowedOrigin(request) {
  const value = request.headers.origin;
  if (value === undefined) {
    return true;
  }
  try {
    const parsed = new URL(value);
    return value === parsed.origin && allowedOrigins.has(parsed.origin);
  } catch {
    return false;
  }
}

function isAuthorized(request) {
  const match = /^Bearer ([^\s]+)$/i.exec(request.headers.authorization ?? "");
  if (!match) {
    return false;
  }
  const expected = createHash("sha256").update(bearerSecret).digest();
  const supplied = createHash("sha256").update(match[1]).digest();
  return timingSafeEqual(expected, supplied);
}

function sendJson(response, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-length": Buffer.byteLength(payload),
    "content-type": "application/json; charset=utf-8",
    ...headers,
  });
  response.end(payload);
}

function log(event, fields = {}, output = process.stdout) {
  output.write(
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      event,
      ...fields,
    })}\n`,
  );
}

function toolResult(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function createFixtureServer() {
  const server = new McpServer(
    { name: "dockmaster-node-mcp-fixture", version: "0.0.0" },
    {
      supportedProtocolVersions: [MODERN_VERSION],
      inputRequired: { legacyShim: false },
    },
  );

  server.registerTool(
    "fixture_state_read",
    {
      title: "Read fixture state",
      description: "Read the current in-memory fixture value and revision.",
      inputSchema: z.object({}),
      outputSchema: stateSchema,
      annotations: { readOnlyHint: true },
    },
    async () => toolResult({ value: memory.value, revision: memory.revision }),
  );

  server.registerTool(
    "fixture_state_change",
    {
      title: "Change fixture state",
      description: "Set the in-memory fixture value or undo the latest set.",
      inputSchema: changeInputSchema,
      outputSchema: changeOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async (input) => {
      if (input.operation === "set") {
        memory.previousValue = memory.value;
        memory.canUndo = true;
        memory.value = input.value;
        memory.revision += 1;
        return toolResult({
          changed: true,
          value: memory.value,
          revision: memory.revision,
        });
      }

      const changed = memory.canUndo;
      if (changed) {
        memory.value = memory.previousValue;
        memory.previousValue = null;
        memory.canUndo = false;
        memory.revision += 1;
      }
      return toolResult({
        changed,
        value: memory.value,
        revision: memory.revision,
      });
    },
  );

  return server;
}

const mcpHandler = createMcpHandler(
  createFixtureServer,
  {
    legacy: "reject",
    onerror: () => log("mcp_error", {}, process.stderr),
  },
);
const handleMcpRequest = toNodeHandler(mcpHandler, {
  onerror: () => log("mcp_adapter_error", {}, process.stderr),
});

let shuttingDown = false;

const httpServer = createServer((request, response) => {
  const requestId = randomUUID();
  const started = process.hrtime.bigint();
  const route =
    request.url === "/mcp"
      ? "mcp"
      : request.url === "/healthz"
        ? "healthz"
        : "unknown";
  response.once("finish", () => {
    log("request_complete", {
      requestId,
      method: request.method,
      route,
      status: response.statusCode,
      durationMs: Number((process.hrtime.bigint() - started) / 1_000_000n),
    });
  });

  if (shuttingDown) {
    sendJson(response, 503, { error: "shutting_down" });
    return;
  }
  if (!validateHostHeader(request.headers.host, allowedHosts).ok) {
    sendJson(response, 403, { error: "forbidden" });
    return;
  }
  if (!isAllowedOrigin(request)) {
    sendJson(response, 403, { error: "forbidden" });
    return;
  }

  if (request.url === "/healthz") {
    if (request.method !== "GET") {
      sendJson(response, 405, { error: "method_not_allowed" }, { allow: "GET" });
      return;
    }
    sendJson(response, 200, { status: "ok" });
    return;
  }

  if (request.url === "/mcp") {
    if (request.method !== "POST") {
      sendJson(
        response,
        405,
        { error: "method_not_allowed" },
        { allow: "POST" },
      );
      return;
    }
    if (!isAuthorized(request)) {
      sendJson(
        response,
        401,
        { error: "unauthorized" },
        { "www-authenticate": "Bearer" },
      );
      return;
    }
    void handleMcpRequest(request, response).catch(() => {
      if (!response.headersSent) {
        sendJson(response, 500, { error: "internal_error" });
      } else if (!response.writableEnded) {
        response.end();
      }
    });
    return;
  }

  sendJson(response, 404, { error: "not_found" });
});

httpServer.listen(port, host, () => {
  const address = httpServer.address();
  const boundPort = typeof address === "object" && address ? address.port : port;
  log("server_ready", { host, port: boundPort });
});

async function shutdown(signal) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  log("shutdown_started", { signal });

  let forced = false;
  const forceTimer = setTimeout(() => {
    forced = true;
    process.exitCode = 1;
    log("shutdown_forced", {}, process.stderr);
    httpServer.closeAllConnections();
  }, 5_000);
  forceTimer.unref();

  await new Promise((resolve, reject) => {
    httpServer.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
  await mcpHandler.close();
  clearTimeout(forceTimer);
  if (!forced) {
    process.exitCode = 0;
    log("shutdown_complete");
  }
}

process.on("SIGTERM", () => {
  void shutdown("SIGTERM").catch(() => {
    process.exitCode = 1;
    log("shutdown_error", {}, process.stderr);
  });
});
