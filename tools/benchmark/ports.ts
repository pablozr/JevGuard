import { createFifoJevPort, type JevEvaluationPort } from "@jevguard/core";
import {
  createCredentialProvider,
  createJevTransport,
  createKeyringCredentialStore,
  createProcessEnvironment,
  createTypeSafeSystemOneClient,
} from "@jevguard/node-infra";
import {
  createObservingClientFactory,
  createResponseObserver,
  type ResponseObserver,
} from "../calibration/response-metadata";

/**
 * Composes the real runtime the plugins use: the concrete credential provider, the
 * TypeSafe transport behind a safe observation wrapper, and the shared FIFO limit.
 * The response observer keeps only a sanitized model id and token counts.
 */
export function createObservingPort(
  concurrency: number,
  observer: ResponseObserver,
): JevEvaluationPort {
  const credentials = createCredentialProvider({
    environment: createProcessEnvironment(),
    store: createKeyringCredentialStore(),
  });

  return createFifoJevPort(
    createJevTransport({
      credentials,
      createClient: createObservingClientFactory(createTypeSafeSystemOneClient, observer),
    }),
    { maxConcurrency: concurrency },
  );
}

export type CredentialCheck = "AVAILABLE" | "MISSING_CREDENTIAL" | "STORE_READ_FAILURE";

export async function checkCredential(): Promise<CredentialCheck> {
  const credentials = createCredentialProvider({
    environment: createProcessEnvironment(),
    store: createKeyringCredentialStore(),
  });

  try {
    const resolution = await credentials.resolve();

    return resolution.status === "AVAILABLE" ? "AVAILABLE" : resolution.reason;
  } catch {
    return "STORE_READ_FAILURE";
  }
}

export function createObserver(): ResponseObserver {
  return createResponseObserver();
}
