#!/usr/bin/env bun
import { performInstall } from "./install";
import { performLogin } from "./login";
import { runCli } from "./run-cli";
import type { CliIO } from "./types";

const io: CliIO = {
  writeOut: (message) => process.stdout.write(`${message}\n`),
  writeErr: (message) => process.stderr.write(`${message}\n`),
};

const exitCode = await runCli(process.argv.slice(2), io, {
  login: performLogin,
  install: performInstall,
});

process.exitCode = exitCode;
