import pkg from "../package.json" with { type: "json" };
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { toolDefinitions } from "../dist/tools/definitions.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "startup-check", version: "1.0.0" });
try {
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"], stderr: "pipe" }));
  if (client.getServerVersion()?.version !== pkg.version) throw new Error("MCP version differs from package version");
  const { tools } = await client.listTools();
  const instructions = client.getInstructions() || "";
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  const table = readme.split("## Available Tools")[1].split("###")[0];
  const documented = [...table.matchAll(/^\| `([a-z_]+)` \|/gm)].map(match => match[1]).sort();
  const advertised = tools.map(tool => tool.name).sort();
  assert.deepEqual(advertised, documented, "README catalogue differs from tools/list");
  assert.deepEqual(advertised, toolDefinitions.map(tool => tool.name).sort());
  for (const tool of tools) {
    const definition = toolDefinitions.find(candidate => candidate.name === tool.name);
    assert.deepEqual(tool.inputSchema, definition.inputSchema);
    assert.deepEqual(tool.annotations, definition.annotations);
    assert.equal(tool.description, definition.description);
    assert.ok(instructions.split(/[^a-z_]+/).includes(tool.name), `Missing from initialize: ${tool.name}`);
  }
  const auth = tools.find(tool => tool.name === "qbo_authenticate");
  if (!auth.inputSchema.properties.callback_url || auth.inputSchema.properties.authorization_code) throw new Error("Unexpected OAuth interface");
  console.log(`MCP startup passed: ${tools.length} tools; callback URL interface verified.`);
} finally { await client.close(); }
