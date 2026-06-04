import {
  createX402Example,
  isDirectRun,
  printExampleIntro,
} from "../_shared/recovery-scenarios.mjs";

export { createX402Example };

if (isDirectRun(import.meta.url, process.argv[1])) {
  printExampleIntro("mcp-x402-experimental", "paid API wrapper MCP");
}