// MCP Server setup and handler registration

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { toolDefinitions, executeTool } from "./tools/index.js";
import { financeInstructions } from "./tools/discovery.js";

// Create MCP server
export const server = new Server(
  {
    name: "quickbooks-mcp",
    version: "0.12.0",
  },
  {
    instructions: financeInstructions(toolDefinitions),
    capabilities: {
      tools: {},
    },
  }
);

// Define available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: toolDefinitions,
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  return executeTool(name, args as Record<string, unknown>);
});
