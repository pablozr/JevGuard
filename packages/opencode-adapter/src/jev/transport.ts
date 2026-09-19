import { TypeSafeClient } from "@typesafe-ai/sdk";
import type {
  CredentialProvider,
  CredentialResolution,
  CredentialUnavailableReason,
  JevEvaluationPort,
  JevEvaluationResult,
  JevFailureReason,
  JevRequest,
} from "@jevguard/core";
import {
  JEV_MODEL,
  type JevTransportDependencies,
  type JevTransportState,
  type TypeSafeClientConfiguration,
  type TypeSafeSystemOneClient,
  type TypeSafeSystemOneRequest,
} from "./types";

const DEFAULT_ALLOWED_CRITERION = "The change does not violate the rule's Violation.";

/** Builds the TypeSafe client options for an explicitly resolved credential. */
export function buildTypeSafeClientConfig(apiKey: string): TypeSafeClientConfiguration {
  return { apiKey, defaultModel: JEV_MODEL, logLevel: "off" };
}

/**
 * Concrete TypeSafe transport for one Jev judgment. The credential is resolved on
 * every `evaluate`; a request rejection or an invalid external response is typed
 * and never thrown, and no error, response body, task, diff, or key is exposed.
 */
export function createJevTransport(dependencies: JevTransportDependencies): JevEvaluationPort {
  return {
    async evaluate(request: JevRequest): Promise<JevEvaluationResult> {
      const credential = await resolveCredential(dependencies.credentials);

      if (credential.status === "UNAVAILABLE") {
        return failed(toFailureReason(credential.reason));
      }

      let client: TypeSafeSystemOneClient;

      try {
        client = dependencies.createClient(credential.apiKey);
      } catch {
        return failed("API_ERROR");
      }

      return evaluateWithClient(client, request);
    },
  };
}

/** Wires the concrete TypeSafe SDK client factory for one credential provider. */
export function createTypeSafeJevTransport(credentials: CredentialProvider): JevEvaluationPort {
  return createJevTransport({ credentials, createClient: createTypeSafeSystemOneClient });
}

export function createTypeSafeSystemOneClient(apiKey: string): TypeSafeSystemOneClient {
  const client = new TypeSafeClient(buildTypeSafeClientConfig(apiKey));

  return {
    systemOne: (request) => client.systemOne(request),
  };
}

async function resolveCredential(provider: CredentialProvider): Promise<CredentialResolution> {
  try {
    return await provider.resolve();
  } catch {
    return { status: "UNAVAILABLE", reason: "STORE_READ_FAILURE" };
  }
}

function toFailureReason(reason: CredentialUnavailableReason): JevFailureReason {
  return reason === "MISSING_CREDENTIAL" ? "MISSING_CREDENTIAL" : "API_ERROR";
}

async function evaluateWithClient(
  client: TypeSafeSystemOneClient,
  request: JevRequest,
): Promise<JevEvaluationResult> {
  let response: unknown;

  try {
    response = await client.systemOne(toSystemOneRequest(request));
  } catch {
    return failed("API_ERROR");
  }

  const violationProbability = readViolationProbability(response);

  if (violationProbability === null) {
    return failed("INVALID_RESPONSE");
  }

  return { status: "EVALUATED", noul: { violationProbability } };
}

function toSystemOneRequest(request: JevRequest): TypeSafeSystemOneRequest {
  const criteria = request.question.criteria;

  return {
    state: toState(request),
    questions: {
      violation: {
        type: "noul",
        instructions: request.question.instructions,
        criteria: {
          true: criteria.violation,
          false: criteria.allowed ?? DEFAULT_ALLOWED_CRITERION,
        },
      },
    },
    model: JEV_MODEL,
  };
}

function toState(request: JevRequest): JevTransportState {
  const criteria = request.question.criteria;

  return {
    task: request.task,
    rule: {
      id: criteria.id,
      description: criteria.description,
      violation: criteria.violation,
      ...(criteria.allowed === undefined ? {} : { allowed: criteria.allowed }),
    },
    change: {
      files: [...request.change.files],
      diff: request.change.diff,
    },
  };
}

function readViolationProbability(response: unknown): number | null {
  if (!isRecord(response)) {
    return null;
  }

  const answers = response.answers;

  if (!isRecord(answers)) {
    return null;
  }

  const violation = answers.violation;

  if (!isRecord(violation) || violation.type !== "noul") {
    return null;
  }

  const noul = violation.noul;

  if (typeof noul !== "number" || !Number.isFinite(noul) || noul < 0 || noul > 1) {
    return null;
  }

  return noul;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failed(reason: JevFailureReason): JevEvaluationResult {
  return { status: "FAILED", reason };
}
