import type { CredentialProvider, JevEvaluationPort } from "@jevguard/core";
import { COMPLEXITY_ANSWER, SCOPE_CREEP_ANSWER } from "@jevguard/core";

/** Model name pinned for the V0.1 Jev judgment. */
export const JEV_MODEL = "jev-latest";

/**
 * TypeSafe client options built for one resolved credential. The API key is always
 * passed explicitly and `logLevel` is always `off` so the SDK never logs request
 * bodies, headers, or credentials.
 */
export interface TypeSafeClientConfiguration {
  readonly apiKey: string;
  readonly defaultModel: string;
  readonly logLevel: "off";
}

export type JevTransportCriterion = {
  readonly id: string;
  readonly description: string;
  readonly violation: string;
  readonly allowed?: string;
};

export type JevTransportRule = JevTransportCriterion;

export type JevTransportChecks = {
  readonly scopeCreep: JevTransportCriterion;
  readonly complexity: JevTransportCriterion;
};

export type JevTransportChange = {
  readonly files: string[];
  readonly diff: string;
};

/**
 * State sent to Jev. A rule request carries `rule`; the built-in batch carries a
 * `checks` object. Declared as type aliases so each carries an implicit index
 * signature for the SDK's JSON-compatible state.
 */
export type JevTransportState =
  | {
      readonly task: string;
      readonly rule: JevTransportRule;
      readonly change: JevTransportChange;
    }
  | {
      readonly task: string;
      readonly checks: JevTransportChecks;
      readonly change: JevTransportChange;
    };

export interface TypeSafeNoulQuestion {
  readonly type: "noul";
  readonly instructions: string;
  readonly criteria: {
    readonly true: string;
    readonly false: string;
  };
}

export type TypeSafeRuleQuestions = {
  readonly violation: TypeSafeNoulQuestion;
};

export type TypeSafeBuiltInQuestions = {
  readonly [SCOPE_CREEP_ANSWER]: TypeSafeNoulQuestion;
  readonly [COMPLEXITY_ANSWER]: TypeSafeNoulQuestion;
};

export type TypeSafeQuestions = TypeSafeRuleQuestions | TypeSafeBuiltInQuestions;

export interface TypeSafeSystemOneRequest {
  readonly state: JevTransportState;
  readonly questions: TypeSafeQuestions;
  readonly model: string;
}

/**
 * Narrow SDK surface used by the transport. Keeping it structural lets tests fake
 * `systemOne` without loading the TypeSafe runtime.
 */
export interface TypeSafeSystemOneClient {
  systemOne(request: TypeSafeSystemOneRequest): Promise<unknown>;
}

export interface JevTransportDependencies {
  readonly credentials: CredentialProvider;
  readonly createClient: (apiKey: string) => TypeSafeSystemOneClient;
}

export type JevTransport = JevEvaluationPort;
