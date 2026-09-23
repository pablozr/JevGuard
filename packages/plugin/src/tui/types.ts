import type { BridgeRuleSnapshot } from "@jevguard/core";
import type {
  OpenCodeFileDiff,
  OpenCodeMessageRecord,
} from "@jevguard/opencode-adapter/attribution";

/**
 * Outcome of one host read. A rejected request, a response without data, or an
 * unexpected shape collapses to `FAILED` instead of throwing across the port.
 */
export type TuiRead<Value> =
  | { readonly status: "OK"; readonly value: Value }
  | { readonly status: "FAILED" };

/** One text part sent to the session. */
export interface TuiTextPart {
  readonly type: "text";
  readonly text: string;
}

/**
 * One prompt interaction. `tools` is present only for proposal prompts, which
 * disable every advertised tool; remediation prompts omit it so normal editing
 * tools stay available.
 */
export interface TuiPromptRequest {
  readonly sessionID: string;
  readonly system: string;
  readonly parts: readonly TuiTextPart[];
  readonly tools?: Readonly<Record<string, boolean>>;
}

/** Read side of the session API used to recover the task and attributed diff. */
export interface TuiSessionReader {
  listMessages(sessionID: string): Promise<TuiRead<readonly OpenCodeMessageRecord[]>>;
  fetchDiff(input: {
    readonly sessionID: string;
    readonly messageID: string;
  }): Promise<TuiRead<readonly OpenCodeFileDiff[]>>;
}

/** Lists the tool IDs the host advertises, so every one can be disabled. */
export interface TuiToolLister {
  listToolIds(): Promise<TuiRead<readonly string[]>>;
}

/** Sends one prompt and returns the assistant's joined text parts. */
export interface TuiPromptSender {
  send(input: TuiPromptRequest): Promise<TuiRead<string>>;
}

/** Asks the user to approve a strategy. Any close without approval cancels. */
export interface TuiProposalDialogs {
  confirm(input: {
    readonly ruleId: string;
    readonly strategy: string;
  }): Promise<"APPLY" | "CANCEL">;
}

/** Transient status feedback. It never carries payloads, diffs, or secrets. */
export interface TuiNotifier {
  notify(input: {
    readonly variant: "info" | "success" | "warning" | "error";
    readonly message: string;
  }): void;
}

/** Complete, safety-checked context for one remediation proposal. */
export interface ProposalContext {
  readonly task: string;
  readonly diff: string;
  readonly files: readonly string[];
  readonly rule: BridgeRuleSnapshot;
  readonly probability: number;
}

export interface RemediationDependencies {
  readonly reader: TuiSessionReader;
  readonly tools: TuiToolLister;
  readonly prompts: TuiPromptSender;
  readonly dialogs: TuiProposalDialogs;
  readonly notify: TuiNotifier;
}

export interface RemediationWorkflow {
  handleCommand(command: string): Promise<void>;
}
