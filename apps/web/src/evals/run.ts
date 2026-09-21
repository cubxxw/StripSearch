/**
 * CLI entry for the runtime-v1 offline evaluation runner.
 *
 * Usage (from the repository root):
 *   npm --prefix apps/web run eval -- --dataset evals/runtime-v1/cases.jsonl \
 *     --output _private/evals/latest [--split discovery|regression]
 */

import { runCli } from './runner.js';

process.exitCode = await runCli(process.argv.slice(2));
