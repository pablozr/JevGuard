import { describe, expect, test } from "vitest";
import {
  createOpenCodeProposalSessionFacade,
  PROPOSER_PERMISSIONS,
  type ProposalContext,
  registerProposalRetryGuard,
} from "../src/index";

interface RecordedCall {
  readonly method: string;
  readonly input: unknown;
}

interface RetryEvent {
  sessionID: string;
  decision?: unknown;
}

type RetryHandler = (retry: RetryEvent) => void;

function fakeContext(options: { model?: unknown; fail?: boolean } = {}) {
  const calls: RecordedCall[] = [];
  const handlers: RetryHandler[] = [];
  const record = (method: string) => async (input: unknown) => {
    calls.push({ method, input });

    if (options.fail === true) {
      throw new Error("host unavailable");
    }

    switch (method) {
      case "get":
        return { id: "ses_1", ...(options.model === undefined ? {} : { model: options.model }) };
      case "create":
        return { id: "ses_child" };
      default:
        return undefined;
    }
  };
  const context = {
    session: {
      get: record("get"),
      create: record("create"),
      prompt: record("prompt"),
      interrupt: record("interrupt"),
      hook: async (name: string, handler: RetryHandler) => {
        calls.push({ method: "hook", input: name });
        handlers.push(handler);

        return { dispose: async () => undefined };
      },
    },
  } as unknown as ProposalContext;

  return { context, calls, handlers };
}

const MODEL = { providerID: "anthropic", modelID: "claude-sonnet-5-5" } as const;

describe("createOpenCodeProposalSessionFacade", () => {
  test("reads the origin session model as provider and model id", async () => {
    const { context, calls } = fakeContext({
      model: { providerID: "anthropic", id: "claude-sonnet-5-5", variant: "high" },
    });

    await expect(
      createOpenCodeProposalSessionFacade(context).originModel("ses_1"),
    ).resolves.toEqual(MODEL);
    expect(calls).toEqual([{ method: "get", input: { sessionID: "ses_1" } }]);
  });

  test("returns null when the origin session has no model", async () => {
    const { context } = fakeContext();

    await expect(
      createOpenCodeProposalSessionFacade(context).originModel("ses_1"),
    ).resolves.toBeNull();
  });

  test("creates the child with the explicit model, deny-all permissions, and no agent", async () => {
    const { context, calls } = fakeContext();

    const sessionID = await createOpenCodeProposalSessionFacade(context).createChildSession({
      parentID: "ses_1",
      title: "JevGuard remediation proposal",
      model: MODEL,
    });

    expect(sessionID).toBe("ses_child");
    expect(calls).toEqual([
      {
        method: "create",
        input: {
          parentID: "ses_1",
          title: "JevGuard remediation proposal",
          model: { providerID: "anthropic", id: "claude-sonnet-5-5" },
          permissions: [{ action: "*", resource: "*", effect: "deny" }],
        },
      },
    ]);
    expect(PROPOSER_PERMISSIONS).toEqual([{ action: "*", resource: "*", effect: "deny" }]);
  });

  test("prompts with text only and interrupts by session id", async () => {
    const { context, calls } = fakeContext();
    const facade = createOpenCodeProposalSessionFacade(context);

    await facade.prompt({ sessionID: "ses_child", text: "proposal body" });
    await facade.interrupt("ses_child");

    expect(calls).toEqual([
      { method: "prompt", input: { sessionID: "ses_child", text: "proposal body" } },
      { method: "interrupt", input: { sessionID: "ses_child" } },
    ]);
  });

  test("propagates host failures to the caller", async () => {
    const { context } = fakeContext({ fail: true });
    const facade = createOpenCodeProposalSessionFacade(context);

    await expect(
      facade.createChildSession({ parentID: "ses_1", title: "proposal", model: MODEL }),
    ).rejects.toThrow("host unavailable");
    await expect(facade.prompt({ sessionID: "ses_child", text: "x" })).rejects.toThrow(
      "host unavailable",
    );
  });
});

describe("registerProposalRetryGuard", () => {
  test("disables retry only for proposer child sessions", async () => {
    const { context, calls, handlers } = fakeContext();

    await registerProposalRetryGuard(context, (sessionID) => sessionID === "ses_child");

    expect(calls).toEqual([{ method: "hook", input: "retry" }]);

    const child: RetryEvent = { sessionID: "ses_child" };
    const other: RetryEvent = { sessionID: "ses_1" };

    handlers[0]?.(child);
    handlers[0]?.(other);

    expect(child.decision).toEqual({ retry: false });
    expect(other.decision).toBeUndefined();
  });
});
