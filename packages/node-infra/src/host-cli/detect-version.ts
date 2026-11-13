import { checkHint, checkLine } from "./described-check";
import type {
  HostDetection,
  HostDoctorCheck,
  HostVersionCheckLabels,
  HostVersionProbe,
  ProcessRunner,
} from "./types";
import { parseVersion, satisfiesRange } from "./version";

const VERSION_CHECKS = {
  SUPPORTED: { status: "OK", code: "VERSION_SUPPORTED" },
  UNSUPPORTED: { status: "FAIL", code: "VERSION_UNSUPPORTED" },
  UNKNOWN_VERSION: { status: "WARN", code: "VERSION_UNKNOWN" },
  NOT_FOUND: { status: "WARN", code: "VERSION_UNKNOWN" },
} as const satisfies Record<
  HostDetection["status"],
  { readonly status: HostDoctorCheck["json"]["status"]; readonly code: string }
>;

/** Runs `<command> --version` and classifies the host against its supported range. */
export async function detectHostVersion(
  processes: ProcessRunner,
  probe: HostVersionProbe,
): Promise<HostDetection> {
  const result = await processes.run({
    command: probe.command,
    args: ["--version"],
    timeoutMs: probe.timeoutMs,
  });
  const output = result.kind === "EXITED" && result.exitCode === 0 ? result.stdout : null;
  const version = parseVersion(output);
  const base = { host: probe.host, supportedRange: probe.range } as const;

  if (version === null) {
    return { ...base, status: output === null ? "NOT_FOUND" : "UNKNOWN_VERSION", version: null };
  }

  const status = satisfiesRange(version, probe.range) ? "SUPPORTED" : "UNSUPPORTED";

  return { ...base, status, version: version.raw };
}

/** The `doctor` check for a detected host version; the wording only varies by host label. */
export function versionDoctorCheck(
  detection: HostDetection,
  labels: HostVersionCheckLabels,
): HostDoctorCheck {
  const { status, code } = VERSION_CHECKS[detection.status];
  const { displayName, command } = labels;
  const range = detection.supportedRange;
  const described = describeVersion(detection, displayName, command, range);

  return {
    json: { id: labels.id, status, code, version: detection.version },
    message: described.message,
    annotation: described.annotation,
  };
}

function describeVersion(
  detection: HostDetection,
  displayName: string,
  command: string,
  range: string,
): { readonly message: string; readonly annotation: string | null } {
  switch (detection.status) {
    case "SUPPORTED":
      return checkLine(`${displayName} ${detection.version} is supported.`);
    case "UNSUPPORTED":
      return checkLine(
        `${displayName} ${detection.version} is not supported.`,
        checkHint(`JevGuard needs ${displayName} ${range}.`),
      );
    case "UNKNOWN_VERSION":
    case "NOT_FOUND":
      return checkLine(
        `The ${displayName} version could not be read from \`${command} --version\`.`,
        checkHint(`Check that ${displayName} ${range} is installed and on PATH.`),
      );
  }
}
