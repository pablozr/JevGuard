#!/usr/bin/env bun
import { performDoctor } from "./doctor/perform";
import { performInstall } from "./install";
import { performLogin } from "./login";
import { performReport } from "./report";
import { performRulesCheck } from "./rules-check/perform";
import { runCli } from "./run-cli";
import type { CliIO } from "./types";

const io: CliIO = {
  writeOut: (message) => process.stdout.write(`${message}\n`),
  writeErr: (message) => process.stderr.write(`${message}\n`),
};

const exitCode = await runCli(process.argv.slice(2), io, {
  login: performLogin,
  install: performInstall,
  report: performReport,
  doctor: performDoctor,
  rulesCheck: performRulesCheck,
});

process.exitCode = exitCode;
