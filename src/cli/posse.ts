#!/usr/bin/env node
// posse.ts — `posse` CLI dispatcher (#121).
//
// A thin entry point so the command syntax is `posse chatgpt ...` (not merely
// `posse-chatgpt ...`). The first positional arg selects the sub-command; currently only
// `chatgpt` is supported. Unknown sub-commands print usage and exit non-zero.
//
// Bundled by esbuild to dist/cli/posse.js. Registered as the `posse` bin in package.json
// so `posse chatgpt ask "..."` resolves when the app is on PATH (and via `npx posse`).
// The standalone `posse-chatgpt` bin remains as an optional alias for backward compat.

import { spawn } from 'node:child_process';
import * as path from 'node:path';

const USAGE = `posse — CLI dispatcher

Usage:
  posse chatgpt <command> [args]   Delegate a sub-task to ChatGPT via the built-in browser.
    Commands: ask, wait, reply, read, cancel, doctor, jobs
    Run 'posse chatgpt help' for full usage.
`;

function main(): void {
  const args = process.argv.slice(2);
  const sub = args[0];

  if (!sub || sub === '-h' || sub === '--help' || sub === 'help') {
    process.stderr.write(USAGE);
    process.exit(sub ? 0 : 1);
  }

  if (sub === 'chatgpt') {
    // Delegate to the chatgpt CLI bundle (sibling file). We exec the same node binary
    // running this dispatcher so the bundled JS runs in a compatible runtime.
    const cliPath = path.join(__dirname, 'posse-chatgpt.js');
    const child = spawn(process.execPath, [cliPath, ...args.slice(1)], { stdio: 'inherit' });
    child.on('exit', (code) => process.exit(code ?? 1));
    child.on('error', (err) => {
      process.stderr.write(`Error: failed to launch posse chatgpt: ${err.message}\n`);
      process.exit(1);
    });
    return;
  }

  process.stderr.write(`Error: unknown sub-command '${sub}'\n\n${USAGE}`);
  process.exit(1);
}

main();
