#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";

const VERSION = "0.1.0";

const cfg = loadConfig();

const server = new McpServer({ name: "overleaf-mcp", version: VERSION });

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
  console.error(`overleaf-mcp ${VERSION} running (git: ${cfg.gitToken ? "on" : "off"})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
