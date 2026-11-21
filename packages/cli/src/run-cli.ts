import type { HostInstallOutcome } from "@jevguard/node-infra";
import { parseHostCommandArguments } from "./arguments";
import { parseCheckArguments } from "./check/arguments";
import {
  CHECK_FAILURE_MESSAGE,
  CHECK_GIT_UNAVAILABLE_MESSAGE,
  CHECK_RANGE_INVALID_MESSAGE,
  CHECK_RULE_NOT_FOUND_MESSAGE,
  CHECK_STAGED_MESSAGE,
  CHECK_USAGE,
  describeCheck,
  describeCheckAnnotations,
  describeRangeTooLarge,
  serializeCheck,
} from "./check/messages";
import type { CheckRequest, CheckResult } from "./check/types";
import { checkExitCode, evaluateCheck } from "./check/verdict";
import {
  DOCTOR_FAILURE_MESSAGE,
  describeDoctorReport,
  serializeDoctorReport,
} from "./doctor/messages";
import { parseFeedbackArguments } from "./feedback/arguments";
import { feedbackMarkExitCode } from "./feedback/exit-code";
import {
  describeFeedbackError,
  describeFeedbackList,
  describeFeedbackMark,
  FEEDBACK_FAILURE_MESSAGE,
  FEEDBACK_INVALID_DECISION_MESSAGE,
  FEEDBACK_USAGE,
  serializeFeedbackList,
} from "./feedback/messages";
import type { FeedbackListResult, FeedbackMarkRequest } from "./feedback/types";
import { parseInitArguments } from "./init/arguments";
import { INIT_FAILURE_MESSAGE } from "./init/messages";
import type { InitResult } from "./init/types";
import {
  describeLoginFailure,
  describeReport,
  LOGIN_ABORTED_MESSAGE,
  LOGIN_SAVED_MESSAGE,
  REPORT_READ_FAILURE_MESSAGE,
  serializeReport,
  USAGE,
} from "./messages";
import { parseReplayArguments } from "./replay/arguments";
import {
  describeReplay,
  REPLAY_FAILURE_MESSAGE,
  REPLAY_USAGE,
  serializeReplay,
} from "./replay/messages";
import type { ReplayResult } from "./replay/types";
import { parseRulesCheckArguments } from "./rules-check/arguments";
import { rulesCheckExitCode } from "./rules-check/exit-code";
import {
  describeDiffInputFailure,
  describeRulesCheck,
  RULE_NOT_FOUND_MESSAGE,
  RULES_CHECK_FAILURE_MESSAGE,
  RULES_CHECK_USAGE,
  serializeRulesCheck,
} from "./rules-check/messages";
import type { RulesCheckArguments, RulesCheckResult } from "./rules-check/types";
import { parseSetupArguments } from "./setup/arguments";
import type { SetupResult } from "./setup/types";
import type { CliDependencies, CliIO } from "./types";

/**
 * Dispatches the `jevguard` CLI: `login`, `install [--project] [--host <id>]`,
 * `setup [--host <id>] [--project] [--init] [--yes] [--agent-delivery]`, `report [--json]`,
 * `doctor [--json] [--host <id>]`, `feedback [--json]`, `feedback <number> <right|wrong>`,
 * `rules check --diff <file|-> ...`, and `check --range <base>..<head> ...`. Any other
 * command, argument, or secret-looking argument yields usage and a nonzero exit, and no
 * argument value is ever echoed. `rules check` exits 0 (clean), 1 (a rule failed),
 * or 2 (it could not complete, including invalid arguments). `check` exits 0 (pass or
 * warnings), 1 (an error-severity rule failed, or a not-judged commit with `--strict`),
 * or 2 (it could not run). `feedback` exits 0
 * (listed or recorded), 1 (invalid input), or 2 (local storage failed).
 */
export async function runCli(
  argv: readonly string[],
  io: CliIO,
  dependencies: CliDependencies,
): Promise<number> {
  if (argv.length === 1 && argv[0] === "login") {
    return runLogin(io, dependencies);
  }

  if (argv[0] === "install") {
    return runInstall(argv.slice(1), io, dependencies);
  }

  if (argv[0] === "setup") {
    return runSetupCommand(argv.slice(1), io, dependencies);
  }

  if (argv[0] === "init") {
    return runInitCommand(argv.slice(1), io, dependencies);
  }

  if (argv[0] === "replay") {
    return runReplayCommand(argv.slice(1), io, dependencies);
  }

  if (argv[0] === "check") {
    return runCheckCommand(argv.slice(1), io, dependencies);
  }

  if (argv.length === 1 && argv[0] === "report") {
    return runReport(io, dependencies, false);
  }

  if (argv.length === 2 && argv[0] === "report" && argv[1] === "--json") {
    return runReport(io, dependencies, true);
  }

  if (argv[0] === "doctor") {
    return runDoctor(argv.slice(1), io, dependencies);
  }

  if (argv[0] === "rules" && argv[1] === "check") {
    return runRulesCheck(argv.slice(2), io, dependencies);
  }

  if (argv[0] === "feedback") {
    return runFeedback(argv.slice(1), io, dependencies);
  }

  io.writeErr(USAGE);
  return 1;
}

async function runFeedback(
  args: readonly string[],
  io: CliIO,
  dependencies: CliDependencies,
): Promise<number> {
  const parsed = parseFeedbackArguments(args);

  switch (parsed.kind) {
    case "USAGE":
      io.writeErr(FEEDBACK_USAGE);
      return 1;
    case "INVALID_DECISION":
      io.writeErr(FEEDBACK_INVALID_DECISION_MESSAGE);
      return 1;
    case "LIST":
      return guardFeedback(io, () => runFeedbackList(io, dependencies, parsed.json));
    case "MARK":
      return guardFeedback(io, () => runFeedbackMark(io, dependencies, parsed.request));
  }
}

async function guardFeedback(io: CliIO, run: () => Promise<number>): Promise<number> {
  try {
    return await run();
  } catch {
    io.writeErr(FEEDBACK_FAILURE_MESSAGE);

    return 2;
  }
}

async function runFeedbackList(
  io: CliIO,
  dependencies: CliDependencies,
  json: boolean,
): Promise<number> {
  const result: FeedbackListResult = await dependencies.feedbackList();

  if (result.status !== "LISTED") {
    io.writeErr(describeFeedbackError(result.status));

    return 2;
  }

  io.writeOut(json ? serializeFeedbackList(result) : describeFeedbackList(result, new Date()));

  return 0;
}

async function runFeedbackMark(
  io: CliIO,
  dependencies: CliDependencies,
  request: FeedbackMarkRequest,
): Promise<number> {
  const result = await dependencies.feedbackMark(request);

  if (result.status === "RECORDED" || result.status === "UNCHANGED") {
    io.writeOut(describeFeedbackMark(result, new Date()));
  } else {
    io.writeErr(describeFeedbackError(result.status));
  }

  return feedbackMarkExitCode(result);
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
  args: readonly string[],
  io: CliIO,
  dependencies: CliDependencies,
): Promise<number> {
  const parsed = parseHostCommandArguments(args, { project: true, json: false });

  if (parsed === null) {
    io.writeErr(USAGE);

    return 1;
  }

  return reportInstall(io, await dependencies.install(parsed.host, parsed.scope));
}

function reportInstall(io: CliIO, outcome: HostInstallOutcome): number {
  const message = outcome.lines.join("\n");

  if (outcome.status === "CHANGED" || outcome.status === "UNCHANGED") {
    io.writeOut(message);

    return 0;
  }

  io.writeErr(message);

  return 1;
}

async function runSetupCommand(
  args: readonly string[],
  io: CliIO,
  dependencies: CliDependencies,
): Promise<number> {
  const request = parseSetupArguments(args);

  if (request === null) {
    io.writeErr(USAGE);

    return 1;
  }

  return reportSetup(io, await dependencies.setup(request));
}

async function runInitCommand(
  args: readonly string[],
  io: CliIO,
  dependencies: CliDependencies,
): Promise<number> {
  const request = parseInitArguments(args);

  if (request === null) {
    io.writeErr(USAGE);

    return 1;
  }

  try {
    return reportInit(io, await dependencies.init(request));
  } catch {
    io.writeErr(INIT_FAILURE_MESSAGE);

    return 2;
  }
}

function reportInit(io: CliIO, result: InitResult): number {
  const message = result.lines.join("\n");

  if (result.status === "NO_HOST" || result.status === "FAILED") {
    io.writeErr(message);

    return 2;
  }

  io.writeOut(message);

  return 0;
}

async function runReplayCommand(
  args: readonly string[],
  io: CliIO,
  dependencies: CliDependencies,
): Promise<number> {
  const parsed = parseReplayArguments(args);

  if (parsed === null) {
    io.writeErr(REPLAY_USAGE);

    return 1;
  }

  let result: ReplayResult;

  try {
    result = await dependencies.replay(parsed.request);
  } catch {
    io.writeErr(REPLAY_FAILURE_MESSAGE);

    return 2;
  }

  if (result.status === "FAILED") {
    io.writeErr(describeReplay(result, parsed.request.last).join("\n"));
    io.writeErr(REPLAY_FAILURE_MESSAGE);

    return 2;
  }

  io.writeOut(
    parsed.json ? serializeReplay(result) : describeReplay(result, parsed.request.last).join("\n"),
  );

  return 0;
}

async function runCheckCommand(
  args: readonly string[],
  io: CliIO,
  dependencies: CliDependencies,
): Promise<number> {
  const parsed = parseCheckArguments(args);

  if (parsed === null) {
    io.writeErr(CHECK_USAGE);

    return 2;
  }

  if (parsed.kind === "STAGED_OUT_OF_V1") {
    io.writeErr(CHECK_STAGED_MESSAGE);

    return 2;
  }

  return runCheck(parsed.request, parsed.output, io, dependencies);
}

async function runCheck(
  request: CheckRequest,
  output: "TEXT" | "JSON" | "ANNOTATIONS",
  io: CliIO,
  dependencies: CliDependencies,
): Promise<number> {
  let result: CheckResult;

  try {
    result = await dependencies.check(request);
  } catch {
    io.writeErr(CHECK_FAILURE_MESSAGE);

    return 2;
  }

  if (result.status === "FAILED") {
    io.writeErr(
      result.reason === "RANGE_INVALID"
        ? CHECK_RANGE_INVALID_MESSAGE
        : CHECK_GIT_UNAVAILABLE_MESSAGE,
    );

    return 2;
  }

  if (result.status === "RANGE_TOO_LARGE") {
    io.writeErr(describeRangeTooLarge(result.totalCommits, result.limit));

    return 2;
  }

  const verdict = evaluateCheck(result.commits);

  if (verdict.verdict === "RULE_NOT_FOUND") {
    io.writeErr(CHECK_RULE_NOT_FOUND_MESSAGE);

    return 2;
  }

  io.writeOut(
    output === "JSON"
      ? serializeCheck(result, verdict)
      : describeCheck(result, verdict, request.range, request.strict).join("\n"),
  );

  if (output === "ANNOTATIONS") {
    io.writeOut(describeCheckAnnotations(verdict).join("\n"));
  }

  return checkExitCode(verdict, request.strict);
}

function reportSetup(io: CliIO, result: SetupResult): number {
  const message = result.lines.join("\n");

  if (result.status === "APPLIED" || result.status === "NOTHING_TO_DO") {
    io.writeOut(message);

    return 0;
  }

  io.writeErr(message);

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

async function runDoctor(
  args: readonly string[],
  io: CliIO,
  dependencies: CliDependencies,
): Promise<number> {
  const parsed = parseHostCommandArguments(args, { project: false, json: true });

  if (parsed === null) {
    io.writeErr(USAGE);

    return 1;
  }

  try {
    const run = await dependencies.doctor([parsed.host]);

    io.writeOut(parsed.json ? serializeDoctorReport(run.report) : describeDoctorReport(run));

    return run.report.status === "FAIL" ? 1 : 0;
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
