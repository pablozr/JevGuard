import { CHAIN_ID_PATTERN, isAttemptCount } from "@jevguard/core";
import type { DeliveryMark, OpenCodeMessage, TurnDelivery } from "./types";

/** Metadata key under which a remediation delivery carries its chain mark. */
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

function markOf(message: OpenCodeMessage): DeliveryMark | null {
  if (message.type !== "synthetic") return null;

  const mark = message.metadata?.[DELIVERY_METADATA_KEY];

  if (typeof mark !== "object" || mark === null || Array.isArray(mark)) return null;

  const { chainId, attempt, maxAttempts } = mark as Record<string, unknown>;

  if (typeof chainId !== "string" || !CHAIN_ID_PATTERN.test(chainId)) return null;
  if (!isAttemptCount(attempt) || !isAttemptCount(maxAttempts) || attempt > maxAttempts) {
    return null;
  }

  return { chainId, attempt, maxAttempts };
}

/**
 * What the inputs of an execution say about a remediation chain (plan §10.1). Only a
 * synthetic message with a valid `metadata.jevguard` mark is a delivery; its text is
 * never trusted, so a pasted frame is a human input. Every input marked: the first mark,
 * not mixed. No mark: `null` (a human turn). Marked and unmarked inputs together: the
 * first mark, mixed, because the correction can no longer be isolated.
 */
export function executionDelivery(inputs: readonly OpenCodeMessage[]): TurnDelivery {
  const marks = inputs.map(markOf);
  const mark = marks.find((candidate) => candidate !== null) ?? null;

  return { mark, mixed: mark !== null && marks.includes(null) };
}
