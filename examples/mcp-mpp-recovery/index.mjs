import {
  createMppExample,
  isDirectRun,
  printExampleIntro,
} from "../_shared/recovery-scenarios.mjs";

export { createMppExample };

if (isDirectRun(import.meta.url, process.argv[1])) {
  printExampleIntro("mcp-mpp-recovery", "scraping/extraction MCP paid step");
}