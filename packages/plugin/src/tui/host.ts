import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import { readPromptResult } from "./reply";
import type { RemediationDependencies, TuiPromptRequest, TuiRead } from "./types";

const PROPOSAL_TITLE_PREFIX = "JevGuard remediation proposal";

/**
 * Binds the OpenCode TUI API to the narrow remediation ports. Reads unwrap the SDK
 * `{ data, error }` result and collapse any rejection or missing data to `FAILED`, so
 * the workflow never observes a thrown transport error. Prompt results are accepted
 * only when they are a completed, error-free assistant turn with non-empty text, so
 * an aborted apply cannot be reported as sent. The proposal dialog resolves `APPLY`
 * only from its confirm action; a cancel or a bare dialog close resolves `CANCEL`,
 * which performs no work.
 */
export function createHostDependencies(api: TuiPluginApi): RemediationDependencies {
  return {
    reader: {
      async listMessages(sessionID) {
        try {
          const result = await api.client.session.messages({ sessionID });

          if (result.error !== undefined || result.data === undefined) {
            return failed();
          }

          return { status: "OK", value: result.data };
        } catch {
          return failed();
        }
      },

      async fetchDiff(input) {
        try {
          const result = await api.client.session.diff({
            sessionID: input.sessionID,
            messageID: input.messageID,
          });

          if (result.error !== undefined || result.data === undefined) {
            return failed();
          }

          return { status: "OK", value: result.data };
        } catch {
          return failed();
        }
      },
    },

    tools: {
      async listToolIds() {
        try {
          const result = await api.client.tool.ids();

          if (result.error !== undefined || result.data === undefined) {
            return failed();
          }

          return { status: "OK", value: result.data };
        } catch {
          return failed();
        }
      },
    },

    prompts: {
      async send(input) {
        try {
          const result = await api.client.session.prompt(toPromptBody(input));

          return readPromptResult(result);
        } catch {
          return failed();
        }
      },
    },

    dialogs: {
      confirm(input) {
        return confirmStrategy(api, input.ruleId, input.strategy);
      },
    },

    notify: {
      notify(input) {
        try {
          api.ui.toast({ variant: input.variant, message: input.message });
        } catch {
          return;
        }
      },
    },
  };
}

function toPromptBody(input: TuiPromptRequest) {
  const body = {
    sessionID: input.sessionID,
    system: input.system,
    parts: input.parts.map((part) => ({ type: part.type, text: part.text })),
  };

  return input.tools === undefined ? body : { ...body, tools: { ...input.tools } };
}

function confirmStrategy(
  api: TuiPluginApi,
  ruleId: string,
  strategy: string,
): Promise<"APPLY" | "CANCEL"> {
  return new Promise((resolve) => {
    let settled = false;

    const settle = (decision: "APPLY" | "CANCEL") => {
      if (settled) {
        return;
      }

      settled = true;
      resolve(decision);
    };

    try {
      api.ui.dialog.replace(
        () =>
          api.ui.DialogConfirm({
            title: `${PROPOSAL_TITLE_PREFIX} (${ruleId})`,
            message: strategy,
            onConfirm: () => settle("APPLY"),
            onCancel: () => settle("CANCEL"),
          }),
        () => settle("CANCEL"),
      );
    } catch {
      settle("CANCEL");
    }
  });
}

function failed(): TuiRead<never> {
  return { status: "FAILED" };
}
