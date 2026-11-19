import { createHostContext } from "../host-context";
import { EXTENSIONS } from "../hosts";
import { runInit } from "./run-init";
import type { InitRequest, InitResult } from "./types";

export function performInit(request: InitRequest): Promise<InitResult> {
  return runInit({ context: createHostContext(), extensions: EXTENSIONS }, request);
}
