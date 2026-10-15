import type { DiffSource, RulesCheckArguments } from "./types";

interface ParsedFlags {
  diff?: string;
  task?: string;
  rule?: string;
  json: boolean;
}

const VALUE_FLAG_KEYS = { "--diff": "diff", "--task": "task", "--rule": "rule" } as const;

type ValueFlag = keyof typeof VALUE_FLAG_KEYS;

/**
 * Parses the arguments after `rules check`. Returns `null` for an unknown or
 * duplicated flag, a missing or empty value, or a missing `--diff`. A value is always
 * the next token, even when it starts with `-`.
 */
export function parseRulesCheckArguments(args: readonly string[]): RulesCheckArguments | null {
  const flags = collectFlags(args);

  if (flags === null || flags.diff === undefined) {
    return null;
  }

  return {
    request: {
      diff: toDiffSource(flags.diff),
      task: flags.task ?? null,
      ruleId: flags.rule ?? null,
    },
    json: flags.json,
  };
}

function collectFlags(args: readonly string[]): ParsedFlags | null {
  const flags: ParsedFlags = { json: false };

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];

    if (token === "--json") {
      if (flags.json) {
        return null;
      }

      flags.json = true;
      continue;
    }

    if (!isValueFlag(token)) {
      return null;
    }

    const value = args[index + 1];
    const key = VALUE_FLAG_KEYS[token];

    if (value === undefined || value === "" || flags[key] !== undefined) {
      return null;
    }

    flags[key] = value;
    index += 1;
  }

  return flags;
}

function isValueFlag(token: string | undefined): token is ValueFlag {
  return token !== undefined && Object.hasOwn(VALUE_FLAG_KEYS, token);
}

function toDiffSource(value: string): DiffSource {
  return value === "-" ? { kind: "STDIN" } : { kind: "FILE", path: value };
}
