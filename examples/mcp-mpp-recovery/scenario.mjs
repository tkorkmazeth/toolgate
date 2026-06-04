import {
  createMppExample,
  runExampleCli,
} from "../_shared/recovery-scenarios.mjs";

await runExampleCli(createMppExample, process.argv[2] ?? "scenario");