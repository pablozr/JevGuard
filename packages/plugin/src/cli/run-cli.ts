import type { InstallOutcome, InstallTarget } from "@jevguard/opencode-adapter";
import type { CliDependencies, CliIO } from "./types";
import {
  describeInstallAborted,
  describeInstallAlreadyInstalled,
  describeInstallFailure,
  describeInstallInstalled,
  describeLoginFailure,
  LOGIN_ABORTED_MESSAGE,
  LOGIN_SAVED_MESSAGE,
  USAGE,
} from "./messages";

/**
 * Dispatches the `jevguard` CLI: `login`, `install`, and `install --project`. Any
 * other command, argument, or secret-looking argument yields usage and a nonzero
 * exit, and no argument value is ever echoed.
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
