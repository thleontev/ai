import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = path.join(root, "mcp", "market-research-sqlite", "server.mjs");
const tempDir = mkdtempSync(path.join(os.tmpdir(), "market-research-sqlite-test-"));

function createClient() {
  const child = spawn(process.execPath, [serverPath], {
    cwd: path.dirname(serverPath),
    env: { ...process.env, MARKET_RESEARCH_DB: path.join(tempDir, "sqlite.db") },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = "";
  let nextId = 1;
  const pending = new Map();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const request = pending.get(message.id);
      if (!request) continue;
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));

  function request(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}`));
      }, 5000);
      pending.set(id, {
        resolve: (value) => { clearTimeout(timeout); resolve(value); },
        reject: (error) => { clearTimeout(timeout); reject(error); },
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  return { child, request };
}

async function call(client, name, args) {
  const result = await client.request("tools/call", { name, arguments: args });
  return JSON.parse(result.content[0].text);
}

async function main() {
  const client = createClient();
  try {
    await client.request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "market-research-sqlite-test", version: "1.0.0" },
    });
    await call(client, "sqlite_batch", {
      sql: "BEGIN; CREATE TABLE sample (id INTEGER PRIMARY KEY, label TEXT NOT NULL); COMMIT;",
    });
    await call(client, "sqlite_execute", {
      sql: "INSERT INTO sample (label) VALUES (?)",
      parameters: ["evidence"],
    });
    const records = await call(client, "sqlite_query", { sql: "SELECT id, label FROM sample" });
    assert.deepEqual(records.rows, [{ id: 1, label: "evidence" }]);
    const integrity = await call(client, "sqlite_integrity_check", {});
    assert.equal(integrity.rows[0].integrity_check, "ok");
    console.log("market-research-sqlite integration tests passed");
  } finally {
    if (client.child.exitCode === null) {
      client.child.kill();
      await new Promise((resolve) => client.child.once("exit", resolve));
    }
  }
}

try {
  await main();
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
