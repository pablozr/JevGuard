import type { TypeSafeSystemOneClient, TypeSafeSystemOneRequest } from "@jevguard/opencode-adapter";

const MAX_MODEL_ID_LENGTH = 64;
const UNKNOWN_MODEL_ID = "unknown";

export interface ResponseObserverSnapshot {
  readonly returnedModels: Readonly<Record<string, number>>;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly responsesWithUsage: number;
}

/**
 * Safe observation of a Jev response envelope. Only a sanitized short model ID and
 * finite nonnegative token counts are retained; the response itself is never stored,
 * serialized, or logged.
 */
export interface ResponseObserver {
  observe(response: unknown): void;
  snapshot(): ResponseObserverSnapshot;
}

export function createResponseObserver(): ResponseObserver {
  const returnedModels = new Map<string, number>();
  let inputTokens = 0;
  let outputTokens = 0;
  let responsesWithUsage = 0;

  return {
    observe(response: unknown): void {
      try {
        if (!isRecord(response)) {
          return;
        }

        const modelId = readModelId(response);

        if (modelId !== null) {
          returnedModels.set(modelId, (returnedModels.get(modelId) ?? 0) + 1);
        }

        const usage = readUsage(response);

        if (usage !== null) {
          inputTokens += usage.inputTokens;
          outputTokens += usage.outputTokens;
          responsesWithUsage += 1;
        }
      } catch {
        return;
      }
    },
    snapshot(): ResponseObserverSnapshot {
      return {
        returnedModels: Object.fromEntries(returnedModels),
        inputTokens,
        outputTokens,
        responsesWithUsage,
      };
    },
  };
}

/**
 * Wraps a real client factory so the untouched request goes out and the untouched
 * response comes back, while a safe observer sees the envelope in between.
 */
export function createObservingClientFactory(
  createClient: (apiKey: string) => TypeSafeSystemOneClient,
  observer: ResponseObserver,
): (apiKey: string) => TypeSafeSystemOneClient {
  return (apiKey: string): TypeSafeSystemOneClient => {
    const client = createClient(apiKey);

    return {
      async systemOne(request: TypeSafeSystemOneRequest): Promise<unknown> {
        const response = await client.systemOne(request);

        observer.observe(response);

        return response;
      },
    };
  };
}

function readModelId(record: Record<string, unknown>): string | null {
  const candidates = [record.model, record.modelId, record.modelVersion, record.version];

  for (const candidate of candidates) {
    if (typeof candidate === "string") {
      return sanitizeModelId(candidate);
    }
  }

  return null;
}

function sanitizeModelId(value: string): string {
  let cleaned = "";

  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;

    if (code >= 0x20 && code !== 0x7f) {
      cleaned += character;
    }
  }

  const trimmed = cleaned.trim().slice(0, MAX_MODEL_ID_LENGTH);

  return trimmed === "" ? UNKNOWN_MODEL_ID : trimmed;
}

interface UsageTotals {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

function readUsage(record: Record<string, unknown>): UsageTotals | null {
  if (!isRecord(record.usage)) {
    return null;
  }

  const usage = record.usage;
  const inputTokens = readTokenCount(usage.input_tokens) ?? readTokenCount(usage.inputTokens) ?? 0;
  const outputTokens =
    readTokenCount(usage.output_tokens) ?? readTokenCount(usage.outputTokens) ?? 0;

  return { inputTokens, outputTokens };
}

function readTokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
