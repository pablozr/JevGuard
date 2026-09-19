import type { CliDependencies, CliIO } from "./types";
import {
  describeLoginFailure,
  LOGIN_ABORTED_MESSAGE,
  LOGIN_SAVED_MESSAGE,
  USAGE,
} from "./messages";

/**
 * Dispatches the `jevguard` CLI. Only `login` is a valid command; any other
 * command, argument, or secret-looking argument yields usage and a nonzero exit.
 */
export async function runCli(
  argv: readonly string[],
  io: CliIO,
  dependencies: CliDependencies,
): Promise<number> {
  if (argv.length !== 1 || argv[0] !== "login") {
    io.writeErr(USAGE);
    return 1;
  }

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
