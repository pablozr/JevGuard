import type { OpenCodeMessage, TurnDelivery } from "./types";

/** Metadata key under which a remediation delivery carries its mark. */
export const DELIVERY_METADATA_KEY = "jevguard";

/** The latest execution in a session context: its final assistant and its inputs. */
export interface LocatedExecution {
  readonly assistant: OpenCodeMessage;
  readonly inputs: readonly OpenCodeMessage[];
}

/**
 * Locates the latest execution: the messages after the last `idle` marker, ignoring
 * trailing `idle` markers (the host may or may not have appended the closing marker
 * when `succeeded` arrives). The turn identity is the last completed assistant; the
 * inputs are every `user`/`synthetic` message of the execution, in order, because
 * queued messages admitted while busy run inside the same execution.
 */
export function locateExecution(messages: readonly OpenCodeMessage[]): LocatedExecution | null {
  let end = messages.length;

  while (end > 0 && messages[end - 1]?.type === "idle") {
    end -= 1;
  }

  let start = end;

  while (start > 0 && messages[start - 1]?.type !== "idle") {
    start -= 1;
  }

  const execution = messages.slice(start, end);
  const assistant = lastCompletedAssistant(execution);

  if (assistant === null) {
    return null;
  }

  return { assistant, inputs: execution.filter(isTaskInput) };
}

function lastCompletedAssistant(messages: readonly OpenCodeMessage[]): OpenCodeMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];

    if (message !== undefined && message.type === "assistant" && message.completed) {
      return message;
    }
  }

  return null;
}

/** Joins the texts of every input of the execution, separated by a blank line. */
export function executionTask(inputs: readonly OpenCodeMessage[]): string | null {
  const task = inputs
    .map((message) => message.text ?? "")
    .filter((text) => text.trim() !== "")
    .join("\n\n");

  return task === "" ? null : task;
}

function isTaskInput(message: OpenCodeMessage): boolean {
  return message.type === "user" || message.type === "synthetic";
}

function isMarkedDelivery(message: OpenCodeMessage): boolean {
  if (message.type !== "synthetic") return false;

  const mark = message.metadata?.[DELIVERY_METADATA_KEY];

  return typeof mark === "object" && mark !== null && !Array.isArray(mark);
}

/**
 * Whether an execution came from a remediation delivery. A synthetic message with a
 * `metadata.jevguard` object, of any shape (an older delivery included), marks it; the
 * message text is never trusted, so a pasted frame is a human input. The mark holds
 * whether or not a human input ran in the same execution.
 */
export function executionDelivery(inputs: readonly OpenCodeMessage[]): TurnDelivery {
  return { fromDelivery: inputs.some(isMarkedDelivery) };
}
