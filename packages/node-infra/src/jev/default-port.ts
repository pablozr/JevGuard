import { type CredentialProvider, createFifoJevPort, type JevEvaluationPort } from "@jevguard/core";
import {
  createCredentialProvider,
  createKeyringCredentialStore,
  createProcessEnvironment,
} from "../credentials";
import { createTypeSafeJevTransport } from "./transport";

const DEFAULT_JEV_MAX_CONCURRENCY = 2;

/** The normal credential provider shared by reviews and `jevguard doctor`. */
export function createDefaultCredentialProvider(): CredentialProvider {
  return createCredentialProvider({
    environment: createProcessEnvironment(),
    store: createKeyringCredentialStore(),
  });
}

/**
 * Composes the shared Jev port: the TypeSafe transport over the normal credential
 * provider, wrapped in one FIFO concurrency limit.
 */
export function createDefaultJevPort(): JevEvaluationPort {
  return createFifoJevPort(createTypeSafeJevTransport(createDefaultCredentialProvider()), {
    maxConcurrency: DEFAULT_JEV_MAX_CONCURRENCY,
  });
}
