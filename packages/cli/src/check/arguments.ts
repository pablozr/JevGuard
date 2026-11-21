import { CHECK_MAX_COMMITS, type CheckOutput, type ParsedCheckArguments } from "./types";

const DECIMAL = /^[1-9][0-9]*$/;

/**
 * One side of a revision range: a branch name, a tag, a hexadecimal revision or a
 * suffix such as `HEAD~2` or `@{upstream}`. It never starts with `-` (a Git flag) or
 * `^` (exclusion syntax, which would silently change the set of units) and it carries
 * no whitespace or shell metacharacter.
 */
const RANGE_PART = /^[A-Za-z0-9@][A-Za-z0-9._/~^@{}-]*$/;

/**
 * Parses the flags of `check`: `--range <base>..<head>`, `--last <n>`, `--rule <id>`,
 * `--strict`, `--json`, `--annotations` and `--staged`. Anything unknown, repeated or
 * without a value is `null`; `--staged` is recognized and refused with its own result,
 * because it is out of v1 until the open decision on pre-commit. `--json` and
 * `--annotations` are mutually exclusive.
 */
export function parseCheckArguments(args: readonly string[]): ParsedCheckArguments | null {
  let range: string | null = null;
  let last: number | null = null;
  let ruleId: string | null = null;
  let strict = false;
  let json = false;
  let annotations = false;
  let staged = false;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    const value = args[index + 1];

    switch (token) {
      case "--range": {
        if (range !== null || value === undefined || !isRange(value)) return null;

        range = value;
        index += 1;
        continue;
      }
      case "--last": {
        if (last !== null || value === undefined || !isCommitCount(value)) return null;

        last = Number(value);
        index += 1;
        continue;
      }
      case "--rule": {
        if (ruleId !== null || value === undefined || value === "") return null;

        ruleId = value;
        index += 1;
        continue;
      }
      case "--strict":
        if (strict) return null;

        strict = true;
        continue;
      case "--json":
        if (json) return null;

        json = true;
        continue;
      case "--annotations":
        if (annotations) return null;

        annotations = true;
        continue;
      case "--staged":
        if (staged) return null;

        staged = true;
        continue;
      default:
        return null;
    }
  }

  if (staged) {
    return range === null ? { kind: "STAGED_OUT_OF_V1" } : null;
  }

  if (range === null || (json && annotations)) return null;

  return {
    kind: "RUN",
    request: { range, last, ruleId, strict },
    output: toOutput(json, annotations),
  };
}

function toOutput(json: boolean, annotations: boolean): CheckOutput {
  if (json) return "JSON";

  return annotations ? "ANNOTATIONS" : "TEXT";
}

/**
 * Accepts exactly one `..` between two valid revision parts. A triple dot is refused
 * (it would judge commits that are not in the head branch), as is a part that starts
 * with a dash, a space or an empty side.
 */
function isRange(value: string): boolean {
  const parts = value.split("..");

  return parts.length === 2 && parts.every((part) => RANGE_PART.test(part));
}

function isCommitCount(value: string): boolean {
  return DECIMAL.test(value) && Number(value) <= CHECK_MAX_COMMITS;
}
