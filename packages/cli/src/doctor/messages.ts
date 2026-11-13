import { checkHint, checkLine, type DescribedCheck } from "@jevguard/node-infra";
import type {
  ConfigCheck,
  CredentialCheck,
  DoctorCheck,
  DoctorReport,
  DoctorReportCheck,
  DoctorRun,
  InvalidRuleSummary,
  RulesCheck,
} from "./types";

export const DOCTOR_FAILURE_MESSAGE = "Could not run the diagnostics.";

const STATUS_COLUMN_WIDTH = 7;
const ID_COLUMN_WIDTH = 17;
const CORE_CHECK_IDS: ReadonlySet<string> = new Set(["credential", "rules", "config"]);
const ANNOTATION_INDENT = " ".repeat(STATUS_COLUMN_WIDTH);

/** Serializable JSON form of the diagnosis for `jevguard doctor --json`. */
export function serializeDoctorReport(report: DoctorReport): string {
  return JSON.stringify(report, null, 2);
}

function isCoreCheck(check: DoctorReportCheck): check is DoctorCheck {
  return CORE_CHECK_IDS.has(check.id);
}

/**
 * Human-readable diagnosis. It prints statuses, typed codes, rule IDs and file paths
 * only: never a credential, a rule description, or any file content.
 */
export function describeDoctorReport({ report, hostChecks }: DoctorRun): string {
  const hostLines = new Map<string, DescribedCheck>(
    hostChecks.map((check) => [
      check.json.id,
      { message: check.message, annotation: check.annotation },
    ]),
  );

  return [
    "JevGuard doctor",
    `Project: ${report.projectRoot}`,
    ...report.checks.flatMap((check) => describeCheck(check, hostLines)),
    describeResult(report),
  ].join("\n");
}

function describeCheck(
  check: DoctorReportCheck,
  hostLines: ReadonlyMap<string, DescribedCheck>,
): readonly string[] {
  const line = isCoreCheck(check)
    ? describeCheckLine(check)
    : (hostLines.get(check.id) ?? { message: check.code, annotation: null });
  const prefix = `${`[${check.status}]`.padEnd(STATUS_COLUMN_WIDTH)}${check.id.padEnd(ID_COLUMN_WIDTH)}`;
  const first = `${prefix}${line.message}`;

  if (line.annotation === null) {
    return [first];
  }

  const [head = "", ...rest] = line.annotation.split("\n");

  return [
    first,
    `${ANNOTATION_INDENT}${head}`,
    ...rest.map((text) => `${ANNOTATION_INDENT}${text}`),
  ];
}

function describeResult(report: DoctorReport): string {
  const fails = report.checks.filter((check) => check.status === "FAIL").length;
  const warns = report.checks.filter((check) => check.status === "WARN").length;

  return `Result: ${report.status} (${fails} fail, ${warns} warn)`;
}

function describeCheckLine(check: DoctorCheck): DescribedCheck {
  switch (check.id) {
    case "credential":
      return describeCredential(check);
    case "rules":
      return describeRules(check);
    case "config":
      return describeConfig(check);
  }
}

function describeCredential(check: CredentialCheck): DescribedCheck {
  switch (check.code) {
    case "CREDENTIAL_STORE":
      return checkLine("API key found in the OS credential store.");
    case "CREDENTIAL_ENVIRONMENT":
      return checkLine(
        "API key found in the TYPESAFE_API_KEY environment override.",
        "note: TYPESAFE_API_KEY override is active (intended for CI/automation).",
      );
    case "MISSING_CREDENTIAL":
      return checkLine("No API key found.", checkHint("Run `jevguard login`."));
    case "STORE_READ_FAILURE":
      return checkLine(
        "The OS credential store could not be read.",
        checkHint(
          "The OS credential store could not be read; check it is available, or set TYPESAFE_API_KEY in CI only.",
        ),
      );
  }
}

function describeRules(check: RulesCheck): DescribedCheck {
  switch (check.code) {
    case "RULES_VALID":
      return checkLine(`.jev/rules.md is valid. Rules: ${check.ruleIds.join(", ")}`);
    case "RULES_INVALID":
      return checkLine(
        `.jev/rules.md has invalid rules: ${check.invalidRules.map(describeInvalidRule).join(", ")}`,
        checkHint("Fix the listed rules; invalid rules are reported UNAVAILABLE (INVALID_RULE)."),
      );
    case "RULES_MISSING":
      return checkLine(
        ".jev/rules.md is absent.",
        checkHint("Create .jev/rules.md (the `jev-init` skill can draft it)."),
      );
    case "RULES_READ_FAILURE":
      return checkLine(
        ".jev/rules.md could not be read.",
        checkHint("Check the file permissions and try again."),
      );
    case "RULES_NOT_CHECKED":
      return checkLine(
        ".jev/rules.md was not checked because .jev/config.yaml could not be read.",
        checkHint("Check the .jev/config.yaml file permissions and try again."),
      );
  }
}

function describeInvalidRule(rule: InvalidRuleSummary): string {
  return `${rule.ruleId ?? "<no id>"} (${rule.code})`;
}

function describeConfig(check: ConfigCheck): DescribedCheck {
  switch (check.code) {
    case "CONFIG_DEFAULTS":
      return checkLine(".jev/config.yaml is absent; documented defaults apply.");
    case "CONFIG_VALID":
      return checkLine(".jev/config.yaml is valid.");
    case "CONFIG_PARSE_INVALID":
      return checkLine(
        ".jev/config.yaml is not valid YAML for JevGuard.",
        checkHint(
          "YAML must be a single plain document without anchors, aliases, tags or duplicate keys.",
        ),
      );
    case "CONFIG_INVALID":
      return checkLine(".jev/config.yaml has an invalid gate configuration.", CONFIG_INVALID_HINT);
    case "REMEDIATION_INVALID":
      return checkLine(
        ".jev/config.yaml has an invalid remediation configuration.",
        CONFIG_INVALID_HINT,
      );
    case "CONFIG_READ_FAILURE":
      return checkLine(
        ".jev/config.yaml could not be read.",
        checkHint("Check the file permissions and try again."),
      );
    case "CONFIG_NOT_CHECKED":
      return checkLine(
        ".jev/config.yaml was not checked because .jev/rules.md could not be read.",
        checkHint("Fix the .jev/rules.md read failure and run `jevguard doctor` again."),
      );
  }
}

const CONFIG_INVALID_HINT = checkHint(
  "Every rule is reported UNAVAILABLE (INVALID_CONFIG) until fixed; see docs/configuration.md.",
);
