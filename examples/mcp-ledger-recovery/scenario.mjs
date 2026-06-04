import {
  createLedgerExample,
  runExampleCli,
} from "../_shared/recovery-scenarios.mjs";

await runExampleCli(createLedgerExample, process.argv[2] ?? "scenario");