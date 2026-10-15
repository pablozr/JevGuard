import {
  diagnosePolicyConfig,
  loadPolicy,
  type PolicyConfigCode,
  type PolicyLoadResult,
  parseRules,
  type RuleParseResults,
} from "@jevguard/core";
import { policyFilePaths } from "@jevguard/node-infra";
import type { InstallInspection } from "@jevguard/opencode-adapter";
import type {
  ConfigCheck,
  ConfigCheckCode,
  CredentialCheck,
  CredentialCheckCode,
  DoctorCheck,
  DoctorDependencies,
  DoctorReport,
  DoctorStatus,
  InvalidRuleSummary,
  OpenCodeCheck,
  OpenCodeCheckCode,
  RulesCheck,
} from "./types";

const CONFIG_CODES: Record<PolicyConfigCode, ConfigCheckCode> = {
  DEFAULTS: "CONFIG_DEFAULTS",
  VALID: "CONFIG_VALID",
  PARSE_INVALID: "CONFIG_PARSE_INVALID",
  GATE_INVALID: "CONFIG_INVALID",
  REMEDIATION_INVALID: "REMEDIATION_INVALID",
};

/**
 * Diagnoses the local JevGuard setup without network access or side effects: the
 * credential source, the fixed `.jev` policy files, and the OpenCode registration.
 * A resolved API key is mapped to a source code immediately and never leaves this
 * module.
 */
export async function diagnose(dependencies: DoctorDependencies): Promise<DoctorReport> {
  const credential = await checkCredential(dependencies);
  const loaded = await loadPolicy(dependencies.policy);
  const paths = policyFilePaths(dependencies.projectRoot);
  const rules = checkRules(paths.rules, loaded);
  const config = checkConfig(dependencies, paths.config, loaded);
  const openCode = await checkOpenCode(dependencies);
  const checks = [credential, rules, config, openCode];

  return {
    version: 1,
    projectRoot: dependencies.projectRoot,
    status: aggregateStatus(checks),
    checks,
  };
}

async function checkCredential(dependencies: DoctorDependencies): Promise<CredentialCheck> {
  const code = await resolveCredentialCode(dependencies);
  const status: DoctorStatus =
    code === "CREDENTIAL_STORE" || code === "CREDENTIAL_ENVIRONMENT" ? "OK" : "FAIL";

  return { id: "credential", status, code };
}

async function resolveCredentialCode(
  dependencies: DoctorDependencies,
): Promise<CredentialCheckCode> {
  try {
    const resolution = await dependencies.credentials.resolve();

    if (resolution.status === "AVAILABLE") {
      return resolution.source === "STORE" ? "CREDENTIAL_STORE" : "CREDENTIAL_ENVIRONMENT";
    }

    return resolution.reason;
  } catch {
    return "STORE_READ_FAILURE";
  }
}

function isRulesReadFailure(loaded: PolicyLoadResult | null): boolean {
  return loaded === null || (loaded.status === "FAILED" && loaded.reason === "RULES_READ_FAILURE");
}

function checkRules(path: string, loaded: PolicyLoadResult | null): RulesCheck {
  if (isRulesReadFailure(loaded)) {
    return rulesCheck("FAIL", "RULES_READ_FAILURE", path);
  }

  if (loaded === null || loaded.status === "FAILED") {
    return rulesCheck("WARN", "RULES_NOT_CHECKED", path);
  }

  const source = loaded.source.rules;

  if (source === null) {
    return rulesCheck("FAIL", "RULES_MISSING", path);
  }

  return summarizeRules(path, parseRules(source));
}

function summarizeRules(path: string, results: RuleParseResults): RulesCheck {
  const ruleIds: string[] = [];
  const invalidRules: InvalidRuleSummary[] = [];

  for (const result of results) {
    if (result.status === "PARSED") {
      ruleIds.push(result.rule.id);
    } else {
      invalidRules.push({ ruleId: result.ruleId, code: result.code });
    }
  }

  if (invalidRules.length > 0) {
    return rulesCheck("FAIL", "RULES_INVALID", path, ruleIds, invalidRules);
  }

  return rulesCheck("OK", "RULES_VALID", path, ruleIds);
}

function rulesCheck(
  status: DoctorStatus,
  code: RulesCheck["code"],
  path: string,
  ruleIds: readonly string[] = [],
  invalidRules: readonly InvalidRuleSummary[] = [],
): RulesCheck {
  return { id: "rules", status, code, path, ruleIds, invalidRules };
}

function checkConfig(
  dependencies: DoctorDependencies,
  path: string,
  loaded: PolicyLoadResult | null,
): ConfigCheck {
  if (isRulesReadFailure(loaded)) {
    return configCheck("WARN", "CONFIG_NOT_CHECKED", path);
  }

  if (loaded === null || loaded.status === "FAILED") {
    return configCheck("FAIL", "CONFIG_READ_FAILURE", path);
  }

  const code =
    CONFIG_CODES[diagnosePolicyConfig(loaded.source.config, dependencies.parseConfig).code];

  return configCheck(
    code === "CONFIG_DEFAULTS" || code === "CONFIG_VALID" ? "OK" : "FAIL",
    code,
    path,
  );
}

function configCheck(status: DoctorStatus, code: ConfigCheckCode, path: string): ConfigCheck {
  return { id: "config", status, code, path };
}

async function checkOpenCode(dependencies: DoctorDependencies): Promise<OpenCodeCheck> {
  const targets = await Promise.all([
    dependencies.inspectOpenCode("global"),
    dependencies.inspectOpenCode("project"),
  ]);
  const code = openCodeCode(targets);
  const status: DoctorStatus = code === "REGISTERED" ? "OK" : "WARN";

  return { id: "opencode-plugin", status, code, targets };
}

function openCodeCode(targets: readonly InstallInspection[]): OpenCodeCheckCode {
  if (targets.some((target) => target.status === "FAILED")) {
    return "INSPECTION_FAILED";
  }

  if (targets.some((target) => target.status === "REGISTERED")) {
    return "REGISTERED";
  }

  return "NOT_REGISTERED";
}

function aggregateStatus(checks: readonly DoctorCheck[]): DoctorStatus {
  if (checks.some((check) => check.status === "FAIL")) {
    return "FAIL";
  }

  return checks.some((check) => check.status === "WARN") ? "WARN" : "OK";
}
