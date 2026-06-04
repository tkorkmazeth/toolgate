import {
  createLedgerExample,
  isDirectRun,
  printExampleIntro,
} from "../_shared/recovery-scenarios.mjs";

export { createLedgerExample };

if (isDirectRun(import.meta.url, process.argv[1])) {
  printExampleIntro("mcp-ledger-recovery", "paper/search MCP local adapter");
}