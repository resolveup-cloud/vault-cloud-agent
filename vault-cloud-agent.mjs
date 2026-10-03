#!/usr/bin/env node
import { runCli } from './lib/cli.mjs';
try {
  await runCli(process.argv.slice(2));
} catch (error) {
  console.error(`Cloud Agent: ${error.message}`);
  process.exitCode = 1;
}
