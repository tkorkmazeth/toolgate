import {
  createX402Example,
  runExampleCli,
} from "../_shared/recovery-scenarios.mjs";

await runExampleCli(createX402Example, process.argv[2] ?? "scenario");