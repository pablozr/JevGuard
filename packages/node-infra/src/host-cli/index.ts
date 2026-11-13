export { createConfirmationPrompt } from "./confirmation";
export { checkHint, checkLine } from "./described-check";
export { detectHostVersion, versionDoctorCheck } from "./detect-version";
export { createNodeProcessRunner } from "./process-runner";
export { createNodeTextFileSystem } from "./text-file-system";
export type {
  ConfirmationPrompt,
  ConfirmationResult,
  DescribedCheck,
  HostCheckStatus,
  HostCliContext,
  HostCliExtension,
  HostDetection,
  HostDoctorCheck,
  HostDoctorCheckJson,
  HostId,
  HostVersionCheckLabels,
  HostVersionProbe,
  HostInstallInspection,
  HostInstallOutcome,
  HostInstallScope,
  HostInstallState,
  ProcessRequest,
  ProcessResult,
  ProcessRunner,
  TextFileSystem,
} from "./types";
export { parseVersion, satisfiesRange } from "./version";
