import type { InstallOutcome, InstallTarget } from "@jevguard/opencode-adapter";
import {
  describeDoctorReport,
  DOCTOR_FAILURE_MESSAGE,
  serializeDoctorReport,
} from "./doctor/messages";
import { rulesCheckExitCode } from "./rules-check/exit-code";
import { parseRulesCheckArguments } from "./rules-check/arguments";
import {
  describeDiffInputFailure,
  describeRulesCheck,
  RULE_NOT_FOUND_MESSAGE,
  RULES_CHECK_FAILURE_MESSAGE,
  RULES_CHECK_USAGE,
  serializeRulesCheck,
} from "./rules-check/messages";
import type { RulesCheckArguments, RulesCheckResult } from "./rules-check/types";
import type { CliDependencies, CliIO } from "./types";
import {
  describeInstallAborted,
  describeInstallAlreadyInstalled,
  describeInstallFailure,
  describeInstallInstalled,
  describeLoginFailure,
  describeReport,
  LOGIN_ABORTED_MESSAGE,
  LOGIN_SAVED_MESSAGE,
  REPORT_READ_FAILURE_MESSAGE,
  serializeReport,
  USAGE,
} from "./messages";

/**
 * Dispatches the `jevguard` CLI: `login`, `install [--project]`, `report [--json]`,
 * `doctor [--json]`, and `rules check --diff <file|-> ...`. Any other command,
 * argument, or secret-looking argument yields usage and a nonzero exit, and no
 * argument value is ever echoed. `rules check` exits 0 (clean), 1 (a rule failed),
 * or 2 (it could not complete, including invalid arguments).
 */
export async function runCli(
  argv: readonly string[],
  io: CliIO,
  dependencies: CliDependencies,
): Promise<number> {
  if (argv.length === 1 && argv[0] === "login") {
    return runLogin(io, dependencies);
  }

  if (argv.length === 1 && argv[0] === "install") {
    return runInstall(io, dependencies, "global");
  }

  if (argv.length === 2 && argv[0] === "install" && argv[1] === "--project") {
    return runInstall(io, dependencies, "project");
  }

  if (argv.length === 1 && argv[0] === "report") {
    return runReport(io, dependencies, false);
  }

  if (argv.length === 2 && argv[0] === "report" && argv[1] === "--json") {
    return runReport(io, dependencies, true);
  }

  if (argv.length === 1 && argv[0] === "doctor") {
    return runDoctor(io, dependencies, false);
  }

  if (argv.length === 2 && argv[0] === "doctor" && argv[1] === "--json") {
    return runDoctor(io, dependencies, true);
  }

  if (argv[0] === "rules" && argv[1] === "check") {
    return runRulesCheck(argv.slice(2), io, dependencies);
  }

  io.writeErr(USAGE);
  return 1;
}

async function runLogin(io: CliIO, dependencies: CliDependencies): Promise<number> {
  const outcome = await dependencies.login();

  if (outcome.status === "SAVED") {
    io.writeOut(LOGIN_SAVED_MESSAGE);
    return 0;
  }

  if (outcome.status === "ABORTED") {
    io.writeErr(LOGIN_ABORTED_MESSAGE);
    return 1;
  }

  io.writeErr(describeLoginFailure(outcome.reason));
  return 1;
}

async function runInstall(
  io: CliIO,
  dependencies: CliDependencies,
  target: InstallTarget,
): Promise<number> {
  const outcome = await dependencies.install(target);

  return reportInstall(io, outcome);
}

function reportInstall(io: CliIO, outcome: InstallOutcome): number {
  if (outcome.status === "INSTALLED") {
    io.writeOut(describeInstallInstalled(outcome.target, outcome.path));
    return 0;
  }

  if (outcome.status === "ALREADY_INSTALLED") {
    io.writeOut(describeInstallAlreadyInstalled(outcome.target, outcome.path));
    return 0;
  }

  if (outcome.status === "ABORTED") {
    io.writeErr(describeInstallAborted(outcome.path));
    return 1;
  }

  io.writeErr(describeInstallFailure(outcome.reason, outcome.path));
  return 1;
}

async function runReport(io: CliIO, dependencies: CliDependencies, json: boolean): Promise<number> {
  try {
    const report = await dependencies.report();

    io.writeOut(json ? serializeReport(report) : describeReport(report));

    return 0;
  } catch {
    io.writeErr(REPORT_READ_FAILURE_MESSAGE);

    return 1;
  }
}

async function runDoctor(io: CliIO, dependencies: CliDependencies, json: boolean): Promise<number> {
  try {
    const report = await dependencies.doctor();

    io.writeOut(json ? serializeDoctorReport(report) : describeDoctorReport(report));

    return report.status === "FAIL" ? 1 : 0;
  } catch {
    io.writeErr(DOCTOR_FAILURE_MESSAGE);

    return 1;
  }
}

async function runRulesCheck(
  args: readonly string[],
  io: CliIO,
  dependencies: CliDependencies,
): Promise<number> {
  const parsed = parseRulesCheckArguments(args);

  if (parsed === null) {
    io.writeErr(RULES_CHECK_USAGE);

    return 2;
  }

  try {
    const result = await dependencies.rulesCheck(parsed.request);

    reportRulesCheck(io, parsed, result);

    return rulesCheckExitCode(result);
  } catch {
    io.writeErr(RULES_CHECK_FAILURE_MESSAGE);

    return 2;
  }
}

function reportRulesCheck(io: CliIO, parsed: RulesCheckArguments, result: RulesCheckResult): void {
  switch (result.status) {
    case "REVIEWED":
      io.writeOut(
        parsed.json ? serializeRulesCheck(result.review) : describeRulesCheck(result.review),
      );
      return;
    case "RULE_NOT_FOUND":
      io.writeErr(RULE_NOT_FOUND_MESSAGE);
      return;
    case "INPUT_FAILED":
      io.writeErr(describeDiffInputFailure(result.reason));
      return;
  }
}
