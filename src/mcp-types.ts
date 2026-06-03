/**
 * MCP Protocol Types (subset needed for Toolgate adapter)
 *
 * These mirror @modelcontextprotocol/sdk types so the adapter
 * works standalone without the npm dependency in dev.
 */

// ─── MCP Tool Content ──────────────────────────────────────

export interface McpTextContent {
  type: "text";
  text: string;
}

export interface McpImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

export type McpContent = McpTextContent | McpImageContent;

// ─── MCP Tool Result ───────────────────────────────────────

export interface McpToolResult {
  content: McpContent[];
  isError?: boolean;
  /** Toolgate extension: structured metadata for agents */
  _meta?: Record<string, unknown>;
}

// ─── MCP Tool Registration (matches server.tool() signature) ─

export interface McpToolRegistration {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  handler: (
    args: Record<string, unknown>,
    extra: McpCallExtra,
  ) => Promise<McpToolResult>;
}

export interface McpCallExtra {
  /** Caller/session identifier — used for balance tracking */
  sessionId?: string;
  /** Transport metadata */
  transport?: {
    type: "stdio" | "sse" | "streamable-http";
    remoteAddress?: string;
  };
  /** Payment proof and other structured metadata from the MCP client */
  _meta?: Record<string, unknown>;
  [key: string]: unknown;
}

// ─── JSON Schema (minimal) ─────────────────────────────────

export interface JsonSchema {
  type: "object";
  properties: Record<string, JsonSchemaProperty>;
  required?: string[];
  description?: string;
}

export interface JsonSchemaProperty {
  type: "string" | "number" | "boolean" | "array" | "object";
  description?: string;
  default?: unknown;
  items?: JsonSchemaProperty;
  enum?: unknown[];
}

// ─── MCP Server Interface (for adapter integration) ────────

export interface McpServerLike {
  tool(
    name: string,
    schema: Record<string, unknown>,
    handler: (
      args: Record<string, unknown>,
      extra: McpCallExtra,
    ) => Promise<McpToolResult>,
  ): void;
}
