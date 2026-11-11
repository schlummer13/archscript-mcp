#!/usr/bin/env node
// ArchScript MCP bridge: connects stdio MCP clients to the MCP server built into
// ArchScript for Mac (http://127.0.0.1:47621/mcp, bearer token).
//
// The bridge only forwards JSON-RPC messages. When ArchScript isn't reachable
// (not running, other machine, wrong token), it still answers initialize and
// tools/list from tools.json, and tool calls return an explanation of how to
// connect the app. No dependencies; Node 18+.

"use strict";

const { execFile } = require("node:child_process");
const readline = require("node:readline");
const path = require("node:path");
const fs = require("node:fs");

const VERSION = require("./package.json").version;
const TOOLS = JSON.parse(fs.readFileSync(path.join(__dirname, "tools.json"), "utf8"));
const SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const INSTRUCTIONS =
  "ArchScript is an architecture-as-code app. The .archs source is the single source of truth; the diagram is generated from it. " +
  "Workflow: call archscript_guide once to learn the language, then list_documents / get_document. Make changes with edit_document " +
  "(structured operations, preferred for small changes) or set_document_source (whole file). Every change shows up live and " +
  "undoable in the user's open window. Check results with the returned diagnostics and render_diagram. Use validate to try " +
  "source without touching a document, and create_document to open a new architecture. " +
  "Requires ArchScript for Mac with 'Allow AI assistants' turned on in Settings → AI.";

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 ? process.argv[index + 1] : undefined;
}

const token = option("token") || process.env.ARCHSCRIPT_TOKEN || "";
const port = Number(option("port") || process.env.ARCHSCRIPT_PORT || 47621);
const endpoint = `http://127.0.0.1:${port}/mcp`;

if (process.argv.includes("--version")) {
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}
if (process.argv.includes("--help")) {
  process.stdout.write(
    "Usage: archscript-mcp [--token <token>] [--port <port>]\n" +
      "Env: ARCHSCRIPT_TOKEN, ARCHSCRIPT_PORT. Copy the token from ArchScript → Settings → AI.\n"
  );
  process.exit(0);
}

function log(message) {
  process.stderr.write(`[archscript-mcp] ${message}\n`);
}

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

class AppError extends Error {}

const SETUP_HELP =
  "Open ArchScript for Mac, turn on Settings → AI → 'Allow AI assistants', and pass the access token shown there " +
  "(ARCHSCRIPT_TOKEN or --token). ArchScript for Mac: https://archscript.dev/guides/ai-assistants/";

async function post(message) {
  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(120_000),
    });
  } catch {
    throw new AppError(`ArchScript for Mac isn't reachable at ${endpoint}. ${SETUP_HELP}`);
  }
  if (response.status === 202) return null;
  const text = await response.text();
  if (response.status === 401) throw new AppError(`ArchScript rejected the access token. ${SETUP_HELP}`);
  if (!response.ok) throw new AppError(`ArchScript answered HTTP ${response.status}: ${text}`);
  return JSON.parse(text);
}

let launchAttempted = false;

function launchApp() {
  return new Promise((resolve) => {
    if (process.platform !== "darwin" || launchAttempted) return resolve(false);
    launchAttempted = true;
    execFile("open", ["-g", "-b", "dev.archscript.mac"], (error) => resolve(!error));
  });
}

async function forward(message) {
  try {
    return await post(message);
  } catch (error) {
    // On a Mac, start ArchScript once and wait for its server.
    if (error instanceof AppError && error.message.includes("isn't reachable") && (await launchApp())) {
      for (let attempt = 0; attempt < 20; attempt++) {
        await new Promise((r) => setTimeout(r, 500));
        try {
          return await post(message);
        } catch (retryError) {
          if (!retryError.message.includes("isn't reachable")) throw retryError;
        }
      }
    }
    throw error;
  }
}

const result = (id, value) => ({ jsonrpc: "2.0", id, result: value });

async function handle(message) {
  const { id, method, params = {} } = message;
  const isRequest = id !== undefined && id !== null && typeof method === "string";

  if (!isRequest) {
    // Notifications and responses: pass through when the app is there.
    post(message).catch(() => {});
    return;
  }

  switch (method) {
    case "initialize": {
      const requested = params.protocolVersion;
      send(
        result(id, {
          protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "archscript", title: "ArchScript", version: VERSION },
          instructions: INSTRUCTIONS,
        })
      );
      // Let the app see the client (shown in Settings → AI); ignore if it's not running.
      post(message).catch(() => {});
      return;
    }
    case "ping":
      send(result(id, {}));
      return;
    case "tools/list":
      try {
        const response = await post(message);
        if (response && response.result && Array.isArray(response.result.tools)) return send(response);
      } catch {
        // Fall back to the bundled tool list.
      }
      send(result(id, { tools: TOOLS }));
      return;
    case "resources/list":
      send(result(id, { resources: [] }));
      return;
    case "prompts/list":
      send(result(id, { prompts: [] }));
      return;
    case "tools/call":
      try {
        const response = await forward(message);
        if (response) send(response);
      } catch (error) {
        send(result(id, { content: [{ type: "text", text: error.message }], isError: true }));
      }
      return;
    default:
      try {
        const response = await forward(message);
        if (response) send(response);
      } catch (error) {
        send({ jsonrpc: "2.0", id, error: { code: -32603, message: error.message } });
      }
  }
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let pending = 0;
let closed = false;

input.on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }
  const messages = Array.isArray(message) ? message : [message];
  for (const item of messages) {
    pending++;
    handle(item)
      .catch((error) => log(error.stack || String(error)))
      .finally(() => {
        pending--;
        if (closed && pending === 0) process.exit(0);
      });
  }
});

input.on("close", () => {
  closed = true;
  if (pending === 0) process.exit(0);
});

if (!token) log(`No access token set. ${SETUP_HELP}`);
