import {
  isCompletedAssistantMessage,
  type OpenCodeMessageInfo,
  type OpenCodeMessageTime,
} from "@jevguard/opencode-adapter/attribution";
import type { TuiRead } from "./types";

/**
 * Interprets one `session.prompt` result. Success is only a completed assistant
 * message with no error and at least one non-empty literal text part. A transport
 * error, missing data, a non-assistant role, an errored or incomplete turn, or
 * text-free content is `FAILED`, so an aborted or failed apply is never reported
 * as sent and never promises a normal re-review.
 */
export function readPromptResult(result: unknown): TuiRead<string> {
  if (!isRecord(result)) {
    return failed();
  }

  if (result.error !== undefined || result.data === undefined) {
    return failed();
  }

  const reply = readCompletedReply(result.data);

  return reply === null ? failed() : { status: "OK", value: reply };
}

function readCompletedReply(data: unknown): string | null {
  if (!isRecord(data)) {
    return null;
  }

  const info = data.info;

  if (!isRecord(info) || info.role !== "assistant") {
    return null;
  }

  if (typeof info.id !== "string" || info.id === "" || !hasFiniteCreated(info.time)) {
    return null;
  }

  if (!isCompletedAssistantMessage(toMessageInfo(info))) {
    return null;
  }

  const parts = data.parts;

  if (!Array.isArray(parts)) {
    return null;
  }

  const text = joinTextParts(parts);

  return text === "" ? null : text;
}

function toMessageInfo(info: Record<string, unknown>): OpenCodeMessageInfo {
  const time = readTime(info.time);

  return {
    id: typeof info.id === "string" ? info.id : "",
    role: "assistant",
    ...(time === undefined ? {} : { time }),
    ...(typeof info.parentID === "string" ? { parentID: info.parentID } : {}),
    error: info.error,
    summary: info.summary,
  };
}

function hasFiniteCreated(value: unknown): boolean {
  return isRecord(value) && typeof value.created === "number" && Number.isFinite(value.created);
}

function readTime(value: unknown): OpenCodeMessageTime | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const created = typeof value.created === "number" ? value.created : Number.NaN;

  return typeof value.completed === "number"
    ? { created, completed: value.completed }
    : { created };
}

function joinTextParts(parts: readonly unknown[]): string {
  return parts
    .filter(isTextPart)
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function isTextPart(value: unknown): value is { readonly type: "text"; readonly text: string } {
  return isRecord(value) && value.type === "text" && typeof value.text === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failed(): TuiRead<never> {
  return { status: "FAILED" };
}
