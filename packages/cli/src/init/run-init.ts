import {
  type HostCliContext,
  type HostCliExtension,
  type HostDetection,
  type HostInstallOutcome,
  policyFilePaths,
} from "@jevguard/node-infra";
import { describeDetection } from "../setup/messages";
import { scaffoldRules } from "../setup/scaffold";
import type { InitPorts, InitRequest, InitResult, RulesOutcome } from "./types";

/** Applying the plugin registration is the whole point of `init`, so it is not asked. */
const ACCEPTING_CONFIRMATION: HostCliContext["confirmation"] = {
  confirm: async () => ({ status: "CONFIRMED" }),
};

/**
 * Sets a project up for JevGuard in one command: registers the plugin of the asked host
 * in the asked scope, and creates `.jev/rules.md` from the example template without
 * ever replacing an existing file. It writes nothing else — no credential, no delivery
 * config.
 */
export async function runInit(ports: InitPorts, request: InitRequest): Promise<InitResult> {
  const extension = ports.extensions.find((candidate) => candidate.id === request.host);
  const detection: HostDetection =
    extension === undefined
      ? { host: request.host, status: "NOT_FOUND", version: null, supportedRange: "" }
      : await extension.detect(ports.context);
  const rulesPath = policyFilePaths(ports.context.projectRoot).rules;

  if (extension === undefined || detection.status !== "SUPPORTED") {
    return noHostResult(extension, detection, request, rulesPath);
  }

  const install = await extension.install(
    { ...ports.context, confirmation: ACCEPTING_CONFIRMATION },
    request.scope,
  );

  if (install.status === "FAILED" || install.status === "DECLINED") {
    return {
      status: "FAILED",
      host: request.host,
      detection,
      install,
      rules: null,
      rulesPath,
      lines: [
        "JevGuard init",
        ...[...install.lines].map((line) => `[fail] ${line}`),
        "Nothing was written. Fix the host registration and run `jevguard init` again.",
      ],
    };
  }

  const rules = await scaffoldRules(ports.context.files, ports.context.projectRoot);

  return {
    status: initStatus(install, rules),
    host: request.host,
    detection,
    install,
    rules,
    rulesPath,
    lines: describeInit(extension, detection, install, rules, rulesPath),
  };
}

function noHostResult(
  extension: HostCliExtension | undefined,
  detection: HostDetection,
  request: InitRequest,
  rulesPath: string,
): InitResult {
  const line =
    extension === undefined
      ? `${request.host} is not a registered host.`
      : describeDetection(extension, detection);

  return {
    status: "NO_HOST",
    host: request.host,
    detection,
    install: null,
    rules: null,
    rulesPath,
    lines: [
      "JevGuard init",
      `[skip] ${line}.`,
      "No supported host was found, so nothing was written. Install a supported host,",
      "then run `jevguard init` again.",
    ],
  };
}

function initStatus(install: HostInstallOutcome, rules: RulesOutcome): InitResult["status"] {
  if (rules === "WRITE_FAILED") return "FAILED";

  return install.status === "CHANGED" || rules === "CREATED" ? "CREATED" : "ALREADY";
}

function describeInit(
  extension: HostCliExtension,
  detection: HostDetection,
  install: HostInstallOutcome,
  rules: RulesOutcome,
  rulesPath: string,
): readonly string[] {
  return [
    "JevGuard init",
    describeDetection(extension, detection),
    ...install.lines.map((line) => `[done] ${line}`),
    ...describeRules(rules, rulesPath),
    "Next: run `jevguard doctor` to check the setup. The first review runs on the next",
    "turn in the host, or try `jevguard replay --last 5` on recent commits.",
  ];
}

function describeRules(rules: RulesOutcome, path: string): readonly string[] {
  switch (rules) {
    case "CREATED":
      return [`[done] Created ${path} with example rules.`];
    case "EXISTS":
      return [`[done] ${path} already exists; left unchanged.`];
    case "WRITE_FAILED":
      return [`[fail] Could not write ${path}. Check the directory permissions.`];
  }
}
