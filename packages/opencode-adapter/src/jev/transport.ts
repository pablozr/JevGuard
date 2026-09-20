import { TypeSafeClient } from "@typesafe-ai/sdk";
import type {
  CredentialProvider,
  CredentialResolution,
  CredentialUnavailableReason,
  JevBuiltInAnswerResult,
  JevBuiltInBatchRequest,
  JevBuiltInBatchResult,
  JevChange,
  JevEvaluationPort,
  JevEvaluationResult,
  JevFailureReason,
  JevRequest,
  JevRuleCriteria,
  JevRuleEvaluationResult,
  JevRuleRequest,
} from "@jevguard/core";
import { COMPLEXITY_ANSWER, SCOPE_CREEP_ANSWER } from "@jevguard/core";
import {
  JEV_MODEL,
  type JevTransportChange,
  type JevTransportChecks,
  type JevTransportCriterion,
  type JevTransportDependencies,
  type TypeSafeClientConfiguration,
  type TypeSafeNoulQuestion,
  type TypeSafeSystemOneClient,
  type TypeSafeSystemOneRequest,
} from "./types";

const DEFAULT_ALLOWED_CRITERION = "The change does not violate the rule's Violation.";

/** Builds the TypeSafe client options for an explicitly resolved credential. */
export function buildTypeSafeClientConfig(apiKey: string): TypeSafeClientConfiguration {
  return { apiKey, defaultModel: JEV_MODEL, logLevel: "off" };
}

/**
 * Concrete TypeSafe transport for Jev judgments. The credential is resolved on
 * every `evaluate`; a request rejection or an invalid external response is typed
 * and never thrown, and no error, response body, task, diff, or key is exposed.
 */
export function createJevTransport(dependencies: JevTransportDependencies): JevEvaluationPort {
  return {
    async evaluate(request: JevRequest): Promise<JevEvaluationResult> {
      const credential = await resolveCredential(dependencies.credentials);

      if (credential.status === "UNAVAILABLE") {
        return failedFor(request, toFailureReason(credential.reason));
      }

      let client: TypeSafeSystemOneClient;

      try {
        client = dependencies.createClient(credential.apiKey);
      } catch {
        return failedFor(request, "API_ERROR");
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
  switch (request.kind) {
    case "RULE":
      return evaluateRuleWithClient(client, request);
    case "BUILT_IN_BATCH":
      return evaluateBatchWithClient(client, request);
  }
}

async function evaluateRuleWithClient(
  client: TypeSafeSystemOneClient,
  request: JevRuleRequest,
): Promise<JevRuleEvaluationResult> {
  let response: unknown;

  try {
    response = await client.systemOne(toRuleSystemOneRequest(request));
  } catch {
    return ruleFailed("API_ERROR");
  }

  const violationProbability = readViolationProbability(response);

  if (violationProbability === null) {
    return ruleFailed("INVALID_RESPONSE");
  }

  return { kind: "RULE", status: "EVALUATED", noul: { violationProbability } };
}

async function evaluateBatchWithClient(
  client: TypeSafeSystemOneClient,
  request: JevBuiltInBatchRequest,
): Promise<JevBuiltInBatchResult> {
  let response: unknown;

  try {
    response = await client.systemOne(toBatchSystemOneRequest(request));
  } catch {
    return batchFailed("API_ERROR");
  }

  return readBatchAnswers(response);
}

function toRuleSystemOneRequest(request: JevRuleRequest): TypeSafeSystemOneRequest {
  return {
    state: {
      task: request.task,
      rule: toCriterion(request.question.criteria),
      change: toChange(request.change),
    },
    questions: {
      violation: toTypeSafeQuestion(request.question.instructions, request.question.criteria),
    },
    model: JEV_MODEL,
  };
}

function toBatchSystemOneRequest(request: JevBuiltInBatchRequest): TypeSafeSystemOneRequest {
  const scopeCreep = request.questions.scopeCreep;
  const complexity = request.questions.complexity;

  return {
    state: {
      task: request.task,
      checks: toChecks(scopeCreep.criteria, complexity.criteria),
      change: toChange(request.change),
    },
    questions: {
      [SCOPE_CREEP_ANSWER]: toTypeSafeQuestion(scopeCreep.instructions, scopeCreep.criteria),
      [COMPLEXITY_ANSWER]: toTypeSafeQuestion(complexity.instructions, complexity.criteria),
    },
    model: JEV_MODEL,
  };
}

function toChecks(scopeCreep: JevRuleCriteria, complexity: JevRuleCriteria): JevTransportChecks {
  return {
    scopeCreep: toCriterion(scopeCreep),
    complexity: toCriterion(complexity),
  };
}

function toChange(change: JevChange): JevTransportChange {
  return { files: [...change.files], diff: change.diff };
}

function toTypeSafeQuestion(instructions: string, criteria: JevRuleCriteria): TypeSafeNoulQuestion {
  return {
    type: "noul",
    instructions,
    criteria: {
      true: criteria.violation,
      false: criteria.allowed ?? DEFAULT_ALLOWED_CRITERION,
    },
  };
}

function toCriterion(criteria: JevRuleCriteria): JevTransportCriterion {
  return {
    id: criteria.id,
    description: criteria.description,
    violation: criteria.violation,
    ...(criteria.allowed === undefined ? {} : { allowed: criteria.allowed }),
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

  return isProbability(noul) ? noul : null;
}

/**
 * A usable batch envelope is an object with an `answers` object; each expected named
 * answer is then validated on its own, so one bad sibling fails alone.
 */
function readBatchAnswers(response: unknown): JevBuiltInBatchResult {
  if (!isRecord(response)) {
    return batchFailed("INVALID_RESPONSE");
  }

  const answers = response.answers;

  if (!isRecord(answers)) {
    return batchFailed("INVALID_RESPONSE");
  }

  return {
    kind: "BUILT_IN_BATCH",
    status: "EVALUATED",
    answers: {
      [SCOPE_CREEP_ANSWER]: readAnswer(answers, SCOPE_CREEP_ANSWER),
      [COMPLEXITY_ANSWER]: readAnswer(answers, COMPLEXITY_ANSWER),
    },
  };
}

function readAnswer(answers: Record<string, unknown>, key: string): JevBuiltInAnswerResult {
  const answer = answers[key];

  if (!isRecord(answer) || answer.type !== "noul") {
    return { status: "FAILED", reason: "INVALID_RESPONSE" };
  }

  const noul = answer.noul;

  if (!isProbability(noul)) {
    return { status: "FAILED", reason: "INVALID_RESPONSE" };
  }

  return { status: "EVALUATED", noul: { violationProbability: noul } };
}

function isProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ruleFailed(reason: JevFailureReason): JevRuleEvaluationResult {
  return { kind: "RULE", status: "FAILED", reason };
}

function batchFailed(reason: JevFailureReason): JevBuiltInBatchResult {
  return { kind: "BUILT_IN_BATCH", status: "FAILED", reason };
}

function failedFor(request: JevRequest, reason: JevFailureReason): JevEvaluationResult {
  return request.kind === "RULE" ? ruleFailed(reason) : batchFailed(reason);
}
