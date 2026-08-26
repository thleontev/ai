import Database from "better-sqlite3";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { resolve } from "node:path";

const DB_PATH = resolve(process.env.MARKET_RESEARCH_DB || "sqlite.db");
const db = new Database(DB_PATH);
db.pragma("foreign_keys = ON");

const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const parameters = z.array(scalar).default([]);
const server = new McpServer({ name: "market-research-sqlite", version: "0.1.0" });

function response(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function normalizedSql(sql) {
  const statement = sql.trim().replace(/;\s*$/, "");
  if (!statement) throw new Error("SQL statement is empty.");
  if (statement.includes(";")) throw new Error("Use sqlite_batch for more than one SQL statement.");
  return statement;
}

function querySql(sql) {
  const statement = normalizedSql(sql);
  if (!/^(select|with|explain|pragma\s+(integrity_check|table_info|index_list|foreign_key_list|database_list|compile_options|schema_version|user_version)\b)/i.test(statement)) {
    throw new Error("sqlite_query accepts SELECT, WITH, EXPLAIN and read-only PRAGMA statements only.");
  }
  return statement;
}

function writeSql(sql) {
  const statement = normalizedSql(sql);
  if (!/^(insert|update|delete|replace|create|alter|drop|vacuum|pragma\s+foreign_keys\s*=)/i.test(statement)) {
    throw new Error("sqlite_execute accepts one write, DDL or PRAGMA foreign_keys statement.");
  }
  return statement;
}

server.tool(
  "sqlite_status",
  "Report the SQLite library version and the configured database path. The database is local and never uploaded.",
  {},
  async () => response({ database_path: DB_PATH, sqlite_version: db.prepare("SELECT sqlite_version() AS version").get().version }),
);

server.tool(
  "sqlite_integrity_check",
  "Run SQLite PRAGMA integrity_check before using historical market-research data.",
  {},
  async () => response({ rows: db.pragma("integrity_check") }),
);

server.tool(
  "sqlite_query",
  "Run one read-only SELECT, WITH, EXPLAIN or supported read-only PRAGMA statement. Parameters use positional ? placeholders.",
  { sql: z.string().min(1), parameters },
  async ({ sql, parameters: values }) => response({ rows: db.prepare(querySql(sql)).all(...values) }),
);

server.tool(
  "sqlite_execute",
  "Run one INSERT, UPDATE, DELETE, REPLACE, DDL or PRAGMA foreign_keys statement. Parameters use positional ? placeholders. Do not modify historical market-research records unless the workflow explicitly requires it.",
  { sql: z.string().min(1), parameters },
  async ({ sql, parameters: values }) => response(db.prepare(writeSql(sql)).run(...values)),
);

server.tool(
  "sqlite_batch",
  "Run a multi-statement DDL or migration script without parameters. Use it for the Product Research schema v3 transaction from references/sqlite-schema.md.",
  { sql: z.string().min(1) },
  async ({ sql }) => {
    db.exec(sql);
    return response({ executed: true });
  },
);

await server.connect(new StdioServerTransport());
