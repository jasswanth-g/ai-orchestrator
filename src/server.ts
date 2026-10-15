import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext, ToolDef } from './tools/define.ts';

/** Builds the MCP server and registers every tool against one context. */
export function buildServer(ctx: ToolContext, tools: ToolDef[]): McpServer {
  const server = new McpServer({ name: 'todo-brain', version: '0.1.0' });

  for (const tool of tools) {
    server.registerTool(tool.name, { description: tool.description, inputSchema: tool.input }, async (args) => {
      try {
        const result = await tool.run(ctx, args as never);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { isError: true, content: [{ type: 'text', text: `${tool.name} failed: ${message}` }] };
      }
    });
  }
  return server;
}
