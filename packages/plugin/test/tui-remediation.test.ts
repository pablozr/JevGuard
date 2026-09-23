import { encodeReviewBridge, type ParsedRule, REVIEW_BRIDGE_COMMAND_PREFIX } from "@jevguard/core";
import type {
  OpenCodeFileDiff,
  OpenCodeMessageRecord,
} from "@jevguard/opencode-adapter/attribution";
import { describe, expect, test } from "vitest";
import { decodeBridgeCommand, readCommandText } from "../src/tui/bridge";
import { PROPOSAL_SYSTEM_INSTRUCTION, REMEDIATION_SYSTEM_INSTRUCTION } from "../src/tui/prompts";
import type {
  TuiPromptRequest,
  TuiPromptSender,
  TuiProposalDialogs,
  TuiRead,
  TuiSessionReader,
  TuiToolLister,
} from "../src/tui/types";
import { createRemediationWorkflow } from "../src/tui/workflow";

const SESSION_ID = "ses_tui";
const USER_ID = "msg_user_tui";
const ASSISTANT_ID = "msg_assistant_tui";
const RULE_ID = "ARCH-1";
const RULE_DESCRIPTION = "Controllers must not hold domain logic.";
const RULE_VIOLATION = "A controller decides domain state directly.";
const RULE_ALLOWED = "HTTP mapping and delegation are allowed.";
const HIDDEN_REASONING = "HIDDEN_REASONING_SENTINEL";
const PATCH = ["--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1 +1 @@", "-old", "+new", ""].join("\n");
const STRATEGY = "1. Extract the decision into a service.\n2. Delegate from the controller.";

function parsedRule(overrides: Partial<ParsedRule> = {}): ParsedRule {
  return {
    id: RULE_ID,
    severity: "error",
    scope: null,
    description: RULE_DESCRIPTION,
    violation: RULE_VIOLATION,
    allowed: RULE_ALLOWED,
    ...overrides,
  };
}

function bridgeCommand(probability = 0.9): string {
  return bridgeCommandForRule(RULE_ID, probability);
}

function bridgeCommandForRule(ruleId: string, probability = 0.9): string {
  return bridgeCommandForSession(SESSION_ID, ASSISTANT_ID, ruleId, probability);
}

function bridgeCommandForSession(
  sessionID: string,
  messageID: string,
  ruleId: string,
  probability = 0.9,
): string {
  const result = encodeReviewBridge({
    sessionID,
    messageID,
    rule: parsedRule({ id: ruleId }),
    probability,
  });

  if (result.status !== "ENCODED") {
    throw new Error(`expected an encoded bridge command, got ${result.reason}`);
  }

  return result.command;
}

async function drain(): Promise<void> {
  for (let index = 0; index < 25; index += 1) {
    await Promise.resolve();
  }
}

function rawCommand(value: unknown): string {
  const encoded = Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

  return `${REVIEW_BRIDGE_COMMAND_PREFIX}${encoded}`;
}

function turnRecords(
  assistantId = ASSISTANT_ID,
  userId = USER_ID,
): readonly OpenCodeMessageRecord[] {
  return [
    {
      info: { id: userId, role: "user" },
      parts: [
        { type: "text", text: "Add the guard." },
        { type: "reasoning", text: HIDDEN_REASONING },
        { type: "tool" },
      ],
    },
    {
      info: {
        id: assistantId,
        role: "assistant",
        parentID: userId,
        time: { created: 1, completed: 2 },
      },
      parts: [],
    },
  ];
}

function patchDiffs(): readonly OpenCodeFileDiff[] {
  return [{ file: "src/a.ts", patch: PATCH }];
}

class FakeReader implements TuiSessionReader {
  records: readonly OpenCodeMessageRecord[] = turnRecords();
  readonly recordsBySession = new Map<string, readonly OpenCodeMessageRecord[]>();
  diffs: readonly OpenCodeFileDiff[] = patchDiffs();
  messagesFailure = false;
  diffFailure = false;
  messagesThrow = false;
  messagesThrowOnce = false;
  readonly messageSessions: string[] = [];
  readonly diffQueries: Array<{ readonly sessionID: string; readonly messageID: string }> = [];

  async listMessages(sessionID: string): Promise<TuiRead<readonly OpenCodeMessageRecord[]>> {
    this.messageSessions.push(sessionID);

    if (this.messagesThrowOnce) {
      this.messagesThrowOnce = false;
      throw new Error("messages transport failure");
    }

    if (this.messagesThrow) {
      throw new Error("messages transport failure");
    }

    const records = this.recordsBySession.get(sessionID) ?? this.records;

    return this.messagesFailure ? { status: "FAILED" } : { status: "OK", value: records };
  }

  async fetchDiff(input: {
    readonly sessionID: string;
    readonly messageID: string;
  }): Promise<TuiRead<readonly OpenCodeFileDiff[]>> {
    this.diffQueries.push({ sessionID: input.sessionID, messageID: input.messageID });

    return this.diffFailure ? { status: "FAILED" } : { status: "OK", value: this.diffs };
  }
}

class FakeTools implements TuiToolLister {
  ids: readonly string[] = ["read", "edit", "bash"];
  failure = false;
  calls = 0;

  async listToolIds(): Promise<TuiRead<readonly string[]>> {
    this.calls += 1;

    return this.failure ? { status: "FAILED" } : { status: "OK", value: this.ids };
  }
}

class FakePrompts implements TuiPromptSender {
  readonly requests: TuiPromptRequest[] = [];
  replies: readonly string[] = [STRATEGY, ""];
  failureIndexes = new Set<number>();

  async send(input: TuiPromptRequest): Promise<TuiRead<string>> {
    const index = this.requests.length;

    this.requests.push(input);

    if (this.failureIndexes.has(index)) {
      return { status: "FAILED" };
    }

    return { status: "OK", value: this.replies[index] ?? "" };
  }
}

class FakeDialogs implements TuiProposalDialogs {
  readonly calls: Array<{ readonly ruleId: string; readonly strategy: string }> = [];
  decision: "APPLY" | "CANCEL" = "CANCEL";
  deferred = false;
  private readonly resolvers = new Map<number, (decision: "APPLY" | "CANCEL") => void>();

  async confirm(input: {
    readonly ruleId: string;
    readonly strategy: string;
  }): Promise<"APPLY" | "CANCEL"> {
    const index = this.calls.length;

    this.calls.push(input);

    if (!this.deferred) {
      return this.decision;
    }

    return new Promise((resolve) => {
      this.resolvers.set(index, resolve);
    });
  }

  resolve(index: number, decision: "APPLY" | "CANCEL"): void {
    this.resolvers.get(index)?.(decision);
  }
}

class FakeNotifier {
  readonly calls: Array<{ readonly variant: string; readonly message: string }> = [];

  notify(input: {
    readonly variant: "info" | "success" | "warning" | "error";
    readonly message: string;
  }): void {
    this.calls.push({ variant: input.variant, message: input.message });
  }
}

interface Harness {
  readonly reader: FakeReader;
  readonly tools: FakeTools;
  readonly prompts: FakePrompts;
  readonly dialogs: FakeDialogs;
  readonly notify: FakeNotifier;
  readonly handle: (command: string) => Promise<void>;
}

function harness(): Harness {
  const reader = new FakeReader();
  const tools = new FakeTools();
  const prompts = new FakePrompts();
  const dialogs = new FakeDialogs();
  const notify = new FakeNotifier();

  const workflow = createRemediationWorkflow({ reader, tools, prompts, dialogs, notify });

  return { reader, tools, prompts, dialogs, notify, handle: workflow.handleCommand };
}

describe("decodeBridgeCommand", () => {
  test("roundtrips a valid encoded bridge command", () => {
    const decoded = decodeBridgeCommand(bridgeCommand());

    expect(decoded.status).toBe("DECODED");

    if (decoded.status !== "DECODED") {
      return;
    }

    expect(decoded.payload).toMatchObject({
      version: 1,
      evaluationId: `${ASSISTANT_ID}:${RULE_ID}`,
      sessionID: SESSION_ID,
      messageID: ASSISTANT_ID,
      probability: 0.9,
    });
  });

  test.each([
    ["a non-string command", 42],
    ["a non-prefix string", "some.other.command"],
    ["a different version prefix", "jevguard.review.v2:abc"],
    ["an empty payload", REVIEW_BRIDGE_COMMAND_PREFIX],
  ])("rejects %s", (_label, command) => {
    expect(decodeBridgeCommand(command).status).toBe("REJECTED");
  });

  test("rejects a payload outside the base64url alphabet", () => {
    expect(decodeBridgeCommand(`${REVIEW_BRIDGE_COMMAND_PREFIX}not+base64/url=`).status).toBe(
      "REJECTED",
    );
  });

  test("rejects an oversized encoded command without decoding it", () => {
    const decoded = decodeBridgeCommand(`${REVIEW_BRIDGE_COMMAND_PREFIX}${"A".repeat(20000)}`);

    expect(decoded).toEqual({ status: "REJECTED", reason: "OVERSIZED_PAYLOAD" });
  });

  test("rejects a payload whose decoded JSON exceeds the byte bound", () => {
    const decoded = decodeBridgeCommand(rawCommand({ padding: "🙅".repeat(2000) }));

    expect(decoded).toEqual({ status: "REJECTED", reason: "OVERSIZED_PAYLOAD" });
  });

  test("rejects non-JSON content", () => {
    const encoded = Buffer.from("not json", "utf8").toString("base64url");

    expect(decodeBridgeCommand(`${REVIEW_BRIDGE_COMMAND_PREFIX}${encoded}`)).toEqual({
      status: "REJECTED",
      reason: "MALFORMED_PAYLOAD",
    });
  });

  test("rejects an unsupported version", () => {
    const decoded = decodeBridgeCommand(rawCommand(validPayload({ version: 2 })));

    expect(decoded).toEqual({ status: "REJECTED", reason: "UNSUPPORTED_VERSION" });
  });

  test("rejects a derived evaluation id that does not match message and rule", () => {
    const decoded = decodeBridgeCommand(
      rawCommand(validPayload({ evaluationId: "someone-else:OTHER" })),
    );

    expect(decoded).toEqual({ status: "REJECTED", reason: "MALFORMED_PAYLOAD" });
  });

  test("rejects a missing rule snapshot", () => {
    const payload = validPayload();
    const withoutRule: Record<string, unknown> = { ...payload };
    delete withoutRule.rule;

    expect(decodeBridgeCommand(rawCommand(withoutRule))).toEqual({
      status: "REJECTED",
      reason: "MALFORMED_PAYLOAD",
    });
  });

  test("rejects an out-of-range probability", () => {
    expect(decodeBridgeCommand(rawCommand(validPayload({ probability: 1.5 })))).toEqual({
      status: "REJECTED",
      reason: "MALFORMED_PAYLOAD",
    });
  });

  test.each([
    ["a root task property", { task: "do the thing" }],
    ["a root diff property", { diff: PATCH }],
    ["an arbitrary root property", { extra: true }],
  ])("rejects %s as a malformed payload", (_label, extra) => {
    expect(decodeBridgeCommand(rawCommand(validPayload(extra)))).toEqual({
      status: "REJECTED",
      reason: "MALFORMED_PAYLOAD",
    });
  });

  test.each([
    ["an arbitrary rule property", { extra: true }],
    ["a rule task property", { task: "do the thing" }],
    ["a rule diff property", { diff: PATCH }],
  ])("rejects %s as a malformed payload", (_label, extra) => {
    const payload = validPayload();
    const rule = payload.rule as Record<string, unknown>;

    expect(decodeBridgeCommand(rawCommand({ ...payload, rule: { ...rule, ...extra } }))).toEqual({
      status: "REJECTED",
      reason: "MALFORMED_PAYLOAD",
    });
  });
});

describe("readCommandText", () => {
  test("reads the command from a tui.command.execute event", () => {
    expect(
      readCommandText({ type: "tui.command.execute", properties: { command: bridgeCommand() } }),
    ).toBe(bridgeCommand());
  });

  test.each([
    ["a null event", null],
    ["a primitive event", "tui.command.execute"],
    ["a different event type", { type: "session.status", properties: { command: "x" } }],
    ["a missing properties object", { type: "tui.command.execute" }],
    ["a non-string command", { type: "tui.command.execute", properties: { command: 7 } }],
  ])("ignores %s", (_label, event) => {
    expect(readCommandText(event)).toBeNull();
  });
});

describe("TUI remediation workflow", () => {
  test("proposes with every tool disabled, then executes only after Apply", async () => {
    const values = harness();
    values.dialogs.decision = "APPLY";

    await values.handle(bridgeCommand());

    expect(values.prompts.requests).toHaveLength(2);

    const proposal = values.prompts.requests[0];
    const remediation = values.prompts.requests[1];

    expect(proposal?.tools).toEqual({ read: false, edit: false, bash: false });
    expect(proposal?.system).toBe(PROPOSAL_SYSTEM_INSTRUCTION);
    expect(remediation?.tools).toBeUndefined();
    expect(remediation?.system).toBe(REMEDIATION_SYSTEM_INSTRUCTION);
    expect(remediation?.parts.some((part) => part.text.includes(STRATEGY))).toBe(true);
    expect(values.dialogs.calls).toEqual([{ ruleId: RULE_ID, strategy: STRATEGY }]);
    expect(values.tools.calls).toBe(1);
  });

  test("keeps rule and diff out of the system instruction and in user content", async () => {
    const values = harness();
    values.dialogs.decision = "APPLY";

    await values.handle(bridgeCommand());

    const proposal = values.prompts.requests[0];

    expect(proposal?.system).not.toContain(RULE_DESCRIPTION);
    expect(proposal?.system).not.toContain(RULE_VIOLATION);
    expect(proposal?.system).not.toContain("src/a.ts");

    const joined = proposal?.parts.map((part) => part.text).join("\n") ?? "";

    expect(joined).toContain("Add the guard.");
    expect(joined).toContain(RULE_DESCRIPTION);
    expect(joined).toContain(RULE_VIOLATION);
    expect(joined).toContain(RULE_ALLOWED);
    expect(joined).toContain(PATCH);
    expect(joined).not.toContain(HIDDEN_REASONING);
  });

  test("forbids test, configuration, and dependency changes in both instructions", async () => {
    const values = harness();
    values.dialogs.decision = "APPLY";

    await values.handle(bridgeCommand());

    for (const request of values.prompts.requests) {
      expect(request.system).toContain("tests, configuration, or dependencies");
    }
  });

  test("does not execute when the user cancels and changes nothing", async () => {
    const values = harness();
    values.dialogs.decision = "CANCEL";

    await values.handle(bridgeCommand());

    expect(values.prompts.requests).toHaveLength(1);
    expect(values.dialogs.calls).toHaveLength(1);
    expect(values.reader.diffQueries).toHaveLength(1);
  });

  test("ignores a duplicate evaluation id and never re-proposes", async () => {
    const values = harness();
    values.dialogs.decision = "APPLY";
    const command = bridgeCommand();

    await values.handle(command);
    await values.handle(command);

    expect(values.prompts.requests).toHaveLength(2);
    expect(values.dialogs.calls).toHaveLength(1);
    expect(values.tools.calls).toBe(1);
  });

  test("serializes same-session failures so each dialog becomes available in order", async () => {
    const values = harness();
    values.dialogs.deferred = true;
    values.prompts.replies = [STRATEGY, STRATEGY];

    const first = values.handle(bridgeCommandForRule("ARCH-1"));
    const second = values.handle(bridgeCommandForRule("ARCH-2"));

    await drain();

    expect(values.prompts.requests).toHaveLength(1);
    expect(values.dialogs.calls).toHaveLength(1);
    expect(values.dialogs.calls[0]?.ruleId).toBe("ARCH-1");

    values.dialogs.resolve(0, "CANCEL");
    await first;
    await drain();

    expect(values.prompts.requests).toHaveLength(2);
    expect(values.dialogs.calls).toHaveLength(2);
    expect(values.dialogs.calls[1]?.ruleId).toBe("ARCH-2");

    values.dialogs.resolve(1, "CANCEL");
    await second;

    expect(values.notify.calls).toHaveLength(0);
  });

  test("serializes different sessions so no two dialogs overlap and order is preserved", async () => {
    const values = harness();
    values.dialogs.deferred = true;
    values.prompts.replies = [STRATEGY, STRATEGY];
    values.reader.recordsBySession.set("ses_a", turnRecords("msg_a", "user_a"));
    values.reader.recordsBySession.set("ses_b", turnRecords("msg_b", "user_b"));

    const first = values.handle(bridgeCommandForSession("ses_a", "msg_a", "ARCH-A"));
    const second = values.handle(bridgeCommandForSession("ses_b", "msg_b", "ARCH-B"));

    await drain();

    expect(values.prompts.requests).toHaveLength(1);
    expect(values.prompts.requests[0]?.sessionID).toBe("ses_a");
    expect(values.dialogs.calls).toHaveLength(1);
    expect(values.dialogs.calls[0]?.ruleId).toBe("ARCH-A");

    values.dialogs.resolve(0, "CANCEL");
    await first;
    await drain();

    expect(values.prompts.requests).toHaveLength(2);
    expect(values.prompts.requests[1]?.sessionID).toBe("ses_b");
    expect(values.dialogs.calls).toHaveLength(2);
    expect(values.dialogs.calls[1]?.ruleId).toBe("ARCH-B");

    values.dialogs.resolve(1, "CANCEL");
    await second;

    expect(values.notify.calls).toHaveLength(0);
  });

  test("dedupes a duplicate evaluation delivered while the first is pending", async () => {
    const values = harness();
    values.dialogs.deferred = true;
    const command = bridgeCommand();

    const first = values.handle(command);
    const second = values.handle(command);

    await drain();

    expect(values.prompts.requests).toHaveLength(1);
    expect(values.dialogs.calls).toHaveLength(1);

    values.dialogs.resolve(0, "CANCEL");
    await Promise.all([first, second]);

    expect(values.prompts.requests).toHaveLength(1);
    expect(values.dialogs.calls).toHaveLength(1);
    expect(values.tools.calls).toBe(1);
  });

  test("contains a queued failure and still handles the next command", async () => {
    const values = harness();
    values.dialogs.deferred = true;
    values.prompts.replies = [STRATEGY];
    values.reader.messagesThrowOnce = true;

    const first = values.handle(bridgeCommandForRule("ARCH-1"));
    const second = values.handle(bridgeCommandForRule("ARCH-2"));

    await drain();

    expect(values.prompts.requests).toHaveLength(1);
    expect(values.dialogs.calls).toHaveLength(1);
    expect(values.dialogs.calls[0]?.ruleId).toBe("ARCH-2");
    expect(values.notify.calls).toHaveLength(1);
    expect(values.notify.calls[0]?.variant).toBe("error");
    expect(values.notify.calls[0]?.message).not.toContain(PATCH);

    values.dialogs.resolve(0, "CANCEL");
    await Promise.all([first, second]);
  });

  test("ignores non-prefix and malformed commands silently", async () => {
    const values = harness();

    await values.handle("some.other.command");
    await values.handle(`${REVIEW_BRIDGE_COMMAND_PREFIX}not+base64/url=`);
    await values.handle(rawCommand({ version: 1 }));

    expect(values.prompts.requests).toHaveLength(0);
    expect(values.reader.messageSessions).toHaveLength(0);
    expect(values.notify.calls).toHaveLength(0);
  });

  test("fetches the diff with the direct parent user message, never the assistant", async () => {
    const values = harness();
    values.dialogs.decision = "APPLY";

    await values.handle(bridgeCommand());

    expect(values.reader.messageSessions).toEqual([SESSION_ID]);
    expect(values.reader.diffQueries).toEqual([{ sessionID: SESSION_ID, messageID: USER_ID }]);
  });

  test("does not propose on a failed messages read", async () => {
    const values = harness();
    values.reader.messagesFailure = true;

    await values.handle(bridgeCommand());

    expect(values.prompts.requests).toHaveLength(0);
    expect(values.notify.calls[0]?.variant).toBe("error");
  });

  test("contains a thrown read failure without crashing or leaking the payload", async () => {
    const values = harness();
    values.reader.messagesThrow = true;

    await expect(values.handle(bridgeCommand())).resolves.toBeUndefined();

    expect(values.prompts.requests).toHaveLength(0);
    expect(values.notify.calls).toHaveLength(1);
    expect(values.notify.calls[0]?.message).not.toContain(RULE_DESCRIPTION);
    expect(values.notify.calls[0]?.message).not.toContain(PATCH);
  });

  test("does not propose when the assistant turn is not completed", async () => {
    const values = harness();
    const records = turnRecords();
    values.reader.records = records.map((record) =>
      record.info.id === ASSISTANT_ID
        ? { ...record, info: { ...record.info, time: { created: 1 } } }
        : record,
    );

    await values.handle(bridgeCommand());

    expect(values.prompts.requests).toHaveLength(0);
    expect(values.notify.calls).toHaveLength(1);
  });

  test("does not propose when the named assistant message is absent", async () => {
    const values = harness();
    values.reader.records = [];

    await values.handle(bridgeCommand());

    expect(values.prompts.requests).toHaveLength(0);
  });

  test("does not propose on a failed diff read", async () => {
    const values = harness();
    values.reader.diffFailure = true;

    await values.handle(bridgeCommand());

    expect(values.prompts.requests).toHaveLength(0);
  });

  test("does not propose on an incomplete file diff", async () => {
    const values = harness();
    values.reader.diffs = [{ file: "src/a.ts" }];

    await values.handle(bridgeCommand());

    expect(values.prompts.requests).toHaveLength(0);
  });

  test("does not propose on an oversized attributed diff", async () => {
    const values = harness();
    values.reader.diffs = [{ file: "src/a.ts", patch: "x".repeat(100_001) }];

    await values.handle(bridgeCommand());

    expect(values.prompts.requests).toHaveLength(0);
  });

  test("does not propose when an applicable path is blocked evidence", async () => {
    const values = harness();
    values.reader.diffs = [
      { file: "src/a.ts", patch: PATCH },
      { file: "src/.env", patch: "SECRET=1" },
    ];

    await values.handle(bridgeCommand());

    expect(values.prompts.requests).toHaveLength(0);
  });

  test("does not propose when the tool list cannot be read", async () => {
    const values = harness();
    values.tools.failure = true;

    await values.handle(bridgeCommand());

    expect(values.prompts.requests).toHaveLength(0);
  });

  test("does not confirm or execute when the proposal call fails", async () => {
    const values = harness();
    values.prompts.failureIndexes.add(0);
    values.dialogs.decision = "APPLY";

    await values.handle(bridgeCommand());

    expect(values.prompts.requests).toHaveLength(1);
    expect(values.dialogs.calls).toHaveLength(0);
    expect(values.notify.calls).toHaveLength(1);
  });

  test("does not confirm or execute when the proposal has no text", async () => {
    const values = harness();
    values.prompts.replies = ["   ", ""];
    values.dialogs.decision = "APPLY";

    await values.handle(bridgeCommand());

    expect(values.dialogs.calls).toHaveLength(0);
    expect(values.prompts.requests).toHaveLength(1);
  });

  test("reports a safe failed execution after Apply without promising a re-review", async () => {
    const values = harness();
    values.prompts.failureIndexes.add(1);
    values.dialogs.decision = "APPLY";

    await values.handle(bridgeCommand());

    expect(values.prompts.requests).toHaveLength(2);
    expect(values.notify.calls).toHaveLength(1);
    expect(values.notify.calls[0]?.variant).toBe("error");
    expect(values.notify.calls[0]?.message).not.toContain("remediation sent");
    expect(values.notify.calls.some((call) => call.variant === "success")).toBe(false);
  });

  test("reports success after an approved execution", async () => {
    const values = harness();
    values.dialogs.decision = "APPLY";

    await values.handle(bridgeCommand());

    expect(values.notify.calls).toEqual([
      { variant: "success", message: "JevGuard remediation sent." },
    ]);
  });
});

function validPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    evaluationId: `${ASSISTANT_ID}:${RULE_ID}`,
    sessionID: SESSION_ID,
    messageID: ASSISTANT_ID,
    rule: {
      id: RULE_ID,
      description: RULE_DESCRIPTION,
      violation: RULE_VIOLATION,
      allowed: RULE_ALLOWED,
    },
    probability: 0.9,
    ...overrides,
  };
}
