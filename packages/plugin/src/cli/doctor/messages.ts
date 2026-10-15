import type { InstallInspection } from "@jevguard/opencode-adapter";
import { describeInstallFailure } from "../messages";
import type {
  ConfigCheck,
  CredentialCheck,
  DoctorCheck,
  DoctorReport,
  InvalidRuleSummary,
  OpenCodeCheck,
  RulesCheck,
} from "./types";

export const DOCTOR_FAILURE_MESSAGE = "Could not run the diagnostics.";

const STATUS_COLUMN_WIDTH = 7;
const ID_COLUMN_WIDTH = 17;
const ANNOTATION_INDENT = " ".repeat(STATUS_COLUMN_WIDTH);

interface CheckLine {
  readonly message: string;
  readonly annotation: string | null;
}

/** Serializable JSON form of the diagnosis for `jevguard doctor --json`. */
export function serializeDoctorReport(report: DoctorReport): string {
  return JSON.stringify(report, null, 2);
}

/**
 * Human-readable diagnosis. It prints statuses, typed codes, rule IDs and file paths
 * only: never a credential, a rule description, or any file content.
 */
export function describeDoctorReport(report: DoctorReport): string {
  return [
    "JevGuard doctor",
    `Project: ${report.projectRoot}`,
    ...report.checks.flatMap(describeCheck),
    describeResult(report),
  ].join("\n");
}

function describeCheck(check: DoctorCheck): readonly string[] {
  const line = describeCheckLine(check);
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

function describeCheckLine(check: DoctorCheck): CheckLine {
  switch (check.id) {
    case "credential":
      return describeCredential(check);
    case "rules":
      return describeRules(check);
    case "config":
      return describeConfig(check);
    case "opencode-plugin":
      return describeOpenCode(check);
  }
}

function describeCredential(check: CredentialCheck): CheckLine {
  switch (check.code) {
    case "CREDENTIAL_STORE":
      return line("API key found in the OS credential store.");
    case "CREDENTIAL_ENVIRONMENT":
      return line(
        "API key found in the TYPESAFE_API_KEY environment override.",
        "note: TYPESAFE_API_KEY override is active (intended for CI/automation).",
      );
    case "MISSING_CREDENTIAL":
      return line("No API key found.", hint("Run `jevguard login`."));
    case "STORE_READ_FAILURE":
      return line(
        "The OS credential store could not be read.",
        hint(
          "The OS credential store could not be read; check it is available, or set TYPESAFE_API_KEY in CI only.",
        ),
      );
  }
}

function describeRules(check: RulesCheck): CheckLine {
  switch (check.code) {
    case "RULES_VALID":
      return line(`.jev/rules.md is valid. Rules: ${check.ruleIds.join(", ")}`);
    case "RULES_INVALID":
      return line(
        `.jev/rules.md has invalid rules: ${check.invalidRules.map(describeInvalidRule).join(", ")}`,
        hint("Fix the listed rules; invalid rules are reported UNAVAILABLE (INVALID_RULE)."),
      );
    case "RULES_MISSING":
      return line(
        ".jev/rules.md is absent.",
        hint("Create .jev/rules.md (the `jev-init` skill can draft it)."),
      );
    case "RULES_READ_FAILURE":
      return line(
        ".jev/rules.md could not be read.",
        hint("Check the file permissions and try again."),
      );
    case "RULES_NOT_CHECKED":
      return line(
        ".jev/rules.md was not checked because .jev/config.yaml could not be read.",
        hint("Check the .jev/config.yaml file permissions and try again."),
      );
  }
}

function describeInvalidRule(rule: InvalidRuleSummary): string {
  return `${rule.ruleId ?? "<no id>"} (${rule.code})`;
}

function describeConfig(check: ConfigCheck): CheckLine {
  switch (check.code) {
    case "CONFIG_DEFAULTS":
      return line(".jev/config.yaml is absent; documented defaults apply.");
    case "CONFIG_VALID":
      return line(".jev/config.yaml is valid.");
    case "CONFIG_PARSE_INVALID":
      return line(
        ".jev/config.yaml is not valid YAML for JevGuard.",
        hint(
          "YAML must be a single plain document without anchors, aliases, tags or duplicate keys.",
        ),
      );
    case "CONFIG_INVALID":
      return line(".jev/config.yaml has an invalid gate configuration.", CONFIG_INVALID_HINT);
    case "REMEDIATION_INVALID":
      return line(
        ".jev/config.yaml has an invalid remediation configuration.",
        CONFIG_INVALID_HINT,
      );
    case "CONFIG_READ_FAILURE":
      return line(
        ".jev/config.yaml could not be read.",
        hint("Check the file permissions and try again."),
      );
    case "CONFIG_NOT_CHECKED":
      return line(
        ".jev/config.yaml was not checked because .jev/rules.md could not be read.",
        hint("Fix the .jev/rules.md read failure and run `jevguard doctor` again."),
      );
  }
}

const CONFIG_INVALID_HINT = hint(
  "Every rule is reported UNAVAILABLE (INVALID_CONFIG) until fixed; see docs/configuration.md.",
);

function describeOpenCode(check: OpenCodeCheck): CheckLine {
  switch (check.code) {
    case "REGISTERED":
      return line(`JevGuard is registered in ${describeRegisteredPaths(check.targets)}.`);
    case "NOT_REGISTERED":
      return line(
        `JevGuard is not registered in ${check.targets.map((target) => target.path).join(" or ")}.`,
        hint("Run `jevguard install` (or `jevguard install --project`)."),
      );
    case "INSPECTION_FAILED":
      return line(
        "The OpenCode configuration could not be inspected.",
        hint(describeInspectionFailures(check.targets)),
      );
  }
}

function describeRegisteredPaths(targets: readonly InstallInspection[]): string {
  return targets
    .filter((target) => target.status === "REGISTERED")
    .map((target) => target.path)
    .join(" and ");
}

function describeInspectionFailures(targets: readonly InstallInspection[]): string {
  return targets
    .flatMap((target) =>
      target.status === "FAILED" ? [describeInstallFailure(target.reason, target.path)] : [],
    )
    .join("\n");
}

function line(message: string, annotation: string | null = null): CheckLine {
  return { message, annotation };
}

function hint(text: string): string {
  return `hint: ${text}`;
}
