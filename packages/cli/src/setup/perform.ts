import { createDefaultCredentialProvider, createNodeProjectProbe } from "@jevguard/node-infra";
import { createHostContext } from "../host-context";
import { EXTENSIONS } from "../hosts";
import { performLogin } from "../login";
import { runSetup } from "./run-setup";
import type { SetupRequest, SetupResult } from "./types";

export function performSetup(request: SetupRequest): Promise<SetupResult> {
  return runSetup(
    {
      context: createHostContext(),
      extensions: EXTENSIONS,
      probe: createNodeProjectProbe(),
      credentials: createDefaultCredentialProvider(),
      login: performLogin,
    },
    request,
  );
}
