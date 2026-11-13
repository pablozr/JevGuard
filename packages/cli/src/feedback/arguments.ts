import type { FeedbackArguments } from "./types";

const NUMBER_PATTERN = /^[1-9][0-9]{0,3}$/;

/**
 * Parses the arguments after `feedback`: nothing or `--json` lists, `<number> right`
 * or `<number> wrong` answers. Decisions are case-sensitive and no value is echoed.
 */
export function parseFeedbackArguments(args: readonly string[]): FeedbackArguments {
  if (args.length === 0) {
    return { kind: "LIST", json: false };
  }

  if (args.length === 1 && args[0] === "--json") {
    return { kind: "LIST", json: true };
  }

  const [number, decision] = args;

  if (args.length !== 2 || number === undefined || !NUMBER_PATTERN.test(number)) {
    return { kind: "USAGE" };
  }

  if (decision === "right") {
    return { kind: "MARK", request: { number: Number(number), decision: "RIGHT" } };
  }

  if (decision === "wrong") {
    return { kind: "MARK", request: { number: Number(number), decision: "WRONG" } };
  }

  return { kind: "INVALID_DECISION" };
}
