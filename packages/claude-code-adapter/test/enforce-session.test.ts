import { describe, expect, test } from "vitest";
import {
  decideEnforce,
  detectSession,
  type EnforceEnvironment,
  type EnforceInput,
  type EnforceSession,
} from "../src/enforce";

function environmentOf(values: Readonly<Record<string, string>>): EnforceEnvironment {
  return { get: (name) => values[name] };
}

const SETTINGS = { rules: ["SECRETS-001"], budgetMs: 8000 };

const FAIL = {
  kind: "RULE" as const,
  turnId: "unit-1",
  scopedPaths: [],
  ruleId: "SECRETS-001",
  severity: "error" as const,
  outcome: "FAIL" as const,
  violationProbability: 0.93,
};

function inputFor(session: EnforceSession): EnforceInput {
  return {
    settings: SETTINGS,
    review: { results: [FAIL] },
    session,
    backgroundTasks: "EMPTY",
    stopHookActive: false,
    unitAlreadyBlocked: false,
    acknowledged: false,
  };
}

/**
 * The shapes below are the host's, read from a real run: the variable is present (never
 * absent) in the environment of a hook process, and its value is the host's own answer.
 */
const TERMINAL = {
  CLAUDECODE: "1",
  CLAUDE_CODE_ENTRYPOINT: "cli",
  CLAUDE_CODE_SESSION_ATTENDED: "1",
};

const DESKTOP = {
  CLAUDECODE: "1",
  CLAUDE_CODE_ENTRYPOINT: "claude-desktop",
  CLAUDE_CODE_SESSION_ATTENDED: "1",
};

const HEADLESS_SDK = {
  CLAUDECODE: "1",
  CLAUDE_CODE_ENTRYPOINT: "sdk-cli",
  CLAUDE_CODE_SESSION_ATTENDED: "0",
};

describe("detectSession", () => {
  test("a terminal session the host marked attended is INTERACTIVE", () => {
    expect(detectSession(environmentOf(TERMINAL))).toBe("INTERACTIVE");
  });

  test("a desktop session the host marked attended is INTERACTIVE", () => {
    expect(detectSession(environmentOf(DESKTOP))).toBe("INTERACTIVE");
  });

  test("a headless run the host marked unattended is NON_INTERACTIVE", () => {
    expect(detectSession(environmentOf(HEADLESS_SDK))).toBe("NON_INTERACTIVE");
  });

  test.each(["+1", "true", "TRUE", "yes", " 1", "on", "  "])(
    "a value the host never writes (%j) is UNKNOWN",
    (value) => {
      expect(
        detectSession(
          environmentOf({
            CLAUDE_CODE_ENTRYPOINT: "cli",
            CLAUDE_CODE_SESSION_ATTENDED: value,
          }),
        ),
      ).toBe("UNKNOWN");
    },
  );

  test("an absent or empty marker is UNKNOWN, never INTERACTIVE", () => {
    expect(detectSession(environmentOf({}))).toBe("UNKNOWN");
    expect(detectSession(environmentOf({ CLAUDE_CODE_SESSION_ATTENDED: "" }))).toBe("UNKNOWN");
  });

  test.each(["sdk-cli", "sdk-ts", "sdk-py"])(
    "an attended value next to a headless entrypoint (%s) is UNKNOWN",
    (entrypoint) => {
      expect(
        detectSession(
          environmentOf({
            CLAUDE_CODE_ENTRYPOINT: entrypoint,
            CLAUDE_CODE_SESSION_ATTENDED: "1",
          }),
        ),
      ).toBe("UNKNOWN");
    },
  );

  test("an absent entrypoint does not veto the host's attended value", () => {
    expect(detectSession(environmentOf({ CLAUDE_CODE_SESSION_ATTENDED: "1" }))).toBe("INTERACTIVE");
  });

  test("only a positively interactive session reaches a block", () => {
    expect(decideEnforce(inputFor("INTERACTIVE"))).toMatchObject({
      block: true,
    });

    for (const session of ["NON_INTERACTIVE", "UNKNOWN"] as const) {
      expect(decideEnforce(inputFor(session))).toEqual({
        block: false,
        code: "ENFORCE_NON_INTERACTIVE",
      });
    }
  });
});
