import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { request as nodeRequest } from "node:http";
import { test } from "node:test";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

const MODERN_VERSION = "2026-07-28";
const TEST_SECRET = "fixture-secret-that-must-never-be-logged";

function discoverBody() {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: "security-probe",
    method: "server/discover",
    params: {
      _meta: {
        "io.modelcontextprotocol/protocolVersion": MODERN_VERSION,
        "io.modelcontextprotocol/clientInfo": {
          name: "security-probe",
          version: "1.0.0",
        },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  });
}

function mcpHeaders(overrides = {}) {
  return {
    accept: "application/json",
    "content-type": "application/json",
    "mcp-method": "server/discover",
    "mcp-protocol-version": MODERN_VERSION,
    origin: "https://fixture.test",
    ...overrides,
  };
}

function rawRequest(url, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const request = nodeRequest(url, { method, headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        resolve({
          status: response.statusCode,
          headers: response.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    request.on("error", reject);
    if (body !== undefined) {
      request.write(body);
    }
    request.end();
  });
}

async function startFixture(t, overrides = {}) {
  const child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      NODE_ENV: "test",
      NODE_MCP_HOST: "127.0.0.1",
      NODE_MCP_PORT: "0",
      NODE_MCP_BEARER_SECRET: TEST_SECRET,
      NODE_MCP_ALLOWED_HOSTS: "127.0.0.1,localhost",
      NODE_MCP_ALLOWED_ORIGINS: "https://fixture.test",
      ...overrides,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  t.after(async () => {
    if (child.exitCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
  });

  let readinessTimer;
  let ready;
  try {
    ready = await Promise.race([
      new Promise((resolve) => {
        child.stdout.on("data", () => {
          for (const line of stdout.trim().split("\n")) {
            try {
              const record = JSON.parse(line);
              if (record.event === "server_ready") {
                resolve(record);
                return;
              }
            } catch {
              // A malformed log record is reported by the timeout or exit assertion.
            }
          }
        });
      }),
      once(child, "exit").then(([code]) => {
        assert.fail(`fixture exited before ready (code ${code}): ${stderr}`);
      }),
      new Promise((_, reject) => {
        readinessTimer = setTimeout(
          () => reject(new Error(`fixture readiness timed out: ${stderr}`)),
          5_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(readinessTimer);
  }

  return {
    child,
    ready,
    request(path, init = {}) {
      return fetch(`http://127.0.0.1:${ready.port}${path}`, init);
    },
    url(path) {
      return new URL(path, `http://127.0.0.1:${ready.port}`);
    },
    raw(path, init) {
      return rawRequest(
        new URL(path, `http://127.0.0.1:${ready.port}`),
        init,
      );
    },
    async stop() {
      if (child.exitCode !== null) {
        return { code: child.exitCode, signal: child.signalCode };
      }
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      const [code, signal] = await exited;
      return { code, signal };
    },
    logs() {
      return `${stdout}\n${stderr}`;
    },
  };
}

async function connectModern(t, fixture) {
  const client = new Client(
    { name: "node-fixture-test", version: "1.0.0" },
    {
      supportedProtocolVersions: [MODERN_VERSION],
      versionNegotiation: { mode: { pin: MODERN_VERSION } },
    },
  );
  const transport = new StreamableHTTPClientTransport(fixture.url("/mcp"), {
    authProvider: { token: async () => TEST_SECRET },
    requestInit: { headers: { origin: "https://fixture.test" } },
  });

  await client.connect(transport);
  t.after(async () => {
    await client.close();
  });
  return client;
}

test("health endpoint reports readiness without authentication", async (t) => {
  const fixture = await startFixture(t);

  const response = await fixture.request("/healthz");

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok" });
});

test("server/discover negotiates only the modern protocol era", async (t) => {
  const fixture = await startFixture(t);

  const client = await connectModern(t, fixture);

  assert.equal(client.getProtocolEra(), "modern");
  assert.equal(client.getNegotiatedProtocolVersion(), MODERN_VERSION);
  assert.ok(client.getDiscoverResult());
});

test("tools/list exposes one read tool and one reversible write tool", async (t) => {
  const fixture = await startFixture(t);
  const client = await connectModern(t, fixture);

  const { tools } = await client.listTools();

  assert.deepEqual(
    tools.map(({ name }) => name).sort(),
    ["fixture_state_change", "fixture_state_read"],
  );
  assert.equal(
    tools.find(({ name }) => name === "fixture_state_read")?.annotations
      ?.readOnlyHint,
    true,
  );
});

test("read tool returns the initial in-memory state", async (t) => {
  const fixture = await startFixture(t);
  const client = await connectModern(t, fixture);

  const result = await client.callTool({
    name: "fixture_state_read",
    arguments: {},
  });

  assert.deepEqual(result.structuredContent, { value: null, revision: 0 });
});

test("write tool supports set, read, undo, and read", async (t) => {
  const fixture = await startFixture(t);
  const client = await connectModern(t, fixture);

  const setResult = await client.callTool({
    name: "fixture_state_change",
    arguments: { operation: "set", value: "temporary-value" },
  });
  assert.deepEqual(setResult.structuredContent, {
    changed: true,
    value: "temporary-value",
    revision: 1,
  });

  const afterSet = await client.callTool({
    name: "fixture_state_read",
    arguments: {},
  });
  assert.deepEqual(afterSet.structuredContent, {
    value: "temporary-value",
    revision: 1,
  });

  const undoResult = await client.callTool({
    name: "fixture_state_change",
    arguments: { operation: "undo" },
  });
  assert.deepEqual(undoResult.structuredContent, {
    changed: true,
    value: null,
    revision: 2,
  });

  const afterUndo = await client.callTool({
    name: "fixture_state_read",
    arguments: {},
  });
  assert.deepEqual(afterUndo.structuredContent, { value: null, revision: 2 });
});

test("undo with no history is a no-op", async (t) => {
  const fixture = await startFixture(t);
  const client = await connectModern(t, fixture);

  const result = await client.callTool({
    name: "fixture_state_change",
    arguments: { operation: "undo" },
  });

  assert.deepEqual(result.structuredContent, {
    changed: false,
    value: null,
    revision: 0,
  });
});

test("undo storage is bounded to the latest set", async (t) => {
  const fixture = await startFixture(t);
  const client = await connectModern(t, fixture);

  await client.callTool({
    name: "fixture_state_change",
    arguments: { operation: "set", value: "first" },
  });
  await client.callTool({
    name: "fixture_state_change",
    arguments: { operation: "set", value: "second" },
  });
  const firstUndo = await client.callTool({
    name: "fixture_state_change",
    arguments: { operation: "undo" },
  });
  const secondUndo = await client.callTool({
    name: "fixture_state_change",
    arguments: { operation: "undo" },
  });

  assert.deepEqual(firstUndo.structuredContent, {
    changed: true,
    value: "first",
    revision: 3,
  });
  assert.deepEqual(secondUndo.structuredContent, {
    changed: false,
    value: "first",
    revision: 3,
  });
});

test("write tool rejects values beyond its bounded schema", async (t) => {
  const fixture = await startFixture(t);
  const client = await connectModern(t, fixture);

  const result = await client.callTool({
    name: "fixture_state_change",
    arguments: { operation: "set", value: "x".repeat(257) },
  });

  assert.equal(result.isError, true);
});

test("MCP endpoint rejects missing and invalid bearer authentication", async (t) => {
  const fixture = await startFixture(t);

  const missing = await fixture.request("/mcp", {
    method: "POST",
    headers: mcpHeaders(),
    body: discoverBody(),
  });
  const invalid = await fixture.request("/mcp", {
    method: "POST",
    headers: mcpHeaders({ authorization: "Bearer wrong-secret" }),
    body: discoverBody(),
  });

  assert.equal(missing.status, 401);
  assert.equal(invalid.status, 401);
  assert.match(missing.headers.get("www-authenticate") ?? "", /^Bearer\b/);
});

test("server rejects Host values outside the allowlist", async (t) => {
  const fixture = await startFixture(t);

  const response = await fixture.raw("/healthz", {
    headers: { host: "attacker.test" },
  });

  assert.equal(response.status, 403);
});

test("server rejects Origin values outside the allowlist", async (t) => {
  const fixture = await startFixture(t);

  const response = await fixture.request("/healthz", {
    headers: { origin: "https://attacker.test" },
  });

  assert.equal(response.status, 403);
});

test("server rejects malformed Origin values that append a path", async (t) => {
  const fixture = await startFixture(t);

  const response = await fixture.request("/healthz", {
    headers: { origin: "https://fixture.test/allowed-looking-path" },
  });

  assert.equal(response.status, 403);
});

test("routes reject unsupported HTTP methods", async (t) => {
  const fixture = await startFixture(t);

  const mcpGet = await fixture.request("/mcp", {
    headers: {
      authorization: `Bearer ${TEST_SECRET}`,
      origin: "https://fixture.test",
    },
  });
  const healthPost = await fixture.request("/healthz", { method: "POST" });

  assert.equal(mcpGet.status, 405);
  assert.equal(mcpGet.headers.get("allow"), "POST");
  assert.equal(healthPost.status, 405);
  assert.equal(healthPost.headers.get("allow"), "GET");
});

test("legacy initialize is rejected without fallback", async (t) => {
  const fixture = await startFixture(t);

  const response = await fixture.request("/mcp", {
    method: "POST",
    headers: mcpHeaders({
      authorization: `Bearer ${TEST_SECRET}`,
      "mcp-method": "initialize",
      "mcp-protocol-version": "2025-11-25",
    }),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "legacy-probe",
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "legacy-probe", version: "1.0.0" },
      },
    }),
  });

  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error?.code, -32022);
  assert.equal(body.error?.data?.requested, "2025-11-25");
  assert.deepEqual(body.error?.data?.supported, [MODERN_VERSION]);
});

test("structured logs omit bearer credentials and tool payloads", async (t) => {
  const sensitiveValue = "tool-payload-that-must-never-be-logged";
  const fixture = await startFixture(t);
  const client = await connectModern(t, fixture);

  await client.callTool({
    name: "fixture_state_change",
    arguments: { operation: "set", value: sensitiveValue },
  });
  await fixture.stop();

  const logs = fixture.logs();
  assert.doesNotMatch(logs, new RegExp(TEST_SECRET));
  assert.doesNotMatch(logs, new RegExp(sensitiveValue));
  const records = logs
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.ok(records.some(({ event }) => event === "request_complete"));
});

test("SIGTERM drains and exits with a structured completion record", async (t) => {
  const fixture = await startFixture(t);
  const health = await fixture.request("/healthz");
  assert.equal(health.status, 200);

  const exit = await fixture.stop();

  assert.deepEqual(exit, { code: 0, signal: null });
  const records = fixture
    .logs()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.ok(records.some(({ event }) => event === "shutdown_started"));
  assert.ok(records.some(({ event }) => event === "shutdown_complete"));
});

test("startup fails closed when the bearer secret is missing", async () => {
  const child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      NODE_MCP_HOST: "127.0.0.1",
      NODE_MCP_PORT: "0",
      NODE_MCP_BEARER_SECRET: "",
      NODE_MCP_ALLOWED_HOSTS: "127.0.0.1",
      NODE_MCP_ALLOWED_ORIGINS: "https://fixture.test",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const [code] = await once(child, "exit");

  assert.equal(code, 1);
  assert.match(stderr, /NODE_MCP_BEARER_SECRET/);
  assert.doesNotMatch(stderr, new RegExp(TEST_SECRET));
});
