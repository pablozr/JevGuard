import { REPLAY_DEFAULT_LAST, REPLAY_MAX_LAST, type ReplayArguments } from "./types";

const DECIMAL = /^[1-9][0-9]*$/;

/**
 * Parses the flags of `replay`: `--last <n>`, `--rule <id>` and `--json`. A count outside
 * 1..{@link REPLAY_MAX_LAST} is refused rather than clamped, so the command never spends
 * more calls than the user asked for. Anything else yields `null`.
 */
export function parseReplayArguments(args: readonly string[]): ReplayArguments | null {
  let last = REPLAY_DEFAULT_LAST;
  let ruleId: string | null = null;
  let json = false;
  let sawLast = false;
  let sawRule = false;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];

    if (token === "--json" && !json) {
      json = true;
      continue;
    }

    if (token === "--last" && !sawLast) {
      const value = args[index + 1];

      if (value === undefined || !DECIMAL.test(value)) return null;

      last = Number(value);

      if (last > REPLAY_MAX_LAST) return null;

      sawLast = true;
      index += 1;
      continue;
    }

    if (token === "--rule" && !sawRule) {
      const value = args[index + 1];

      if (value === undefined || value === "") return null;

      ruleId = value;
      sawRule = true;
      index += 1;
      continue;
    }

    return null;
  }

  return { request: { last, ruleId }, json };
}
