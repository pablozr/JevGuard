import type { TurnFile } from "@jevguard/core";
import type {
  CalibrationCategory,
  CalibrationDifficulty,
  CalibrationLabel,
  SyntheticCalibrationFixture,
} from "./types";

export const CALIBRATION_SEED = "jevguard-calibration-v1";
export const DEFAULT_FIXTURE_COUNT = 160;
export const MAX_FIXTURE_COUNT = 500;

type LanguageId = "typescript" | "python" | "go";
type StructureKind = "factory" | "registry" | "pipeline" | "interface" | "bus" | "layer";

interface Revision {
  readonly path: string;
  readonly before: readonly string[];
  readonly after: readonly string[];
}

interface LanguageProfile {
  readonly id: LanguageId;
  readonly source: string;
  readonly test: string;
  readonly docs: string;
  readonly config: string;
  readonly manifest: string;
}

const LANGUAGES: readonly [LanguageProfile, ...LanguageProfile[]] = [
  {
    id: "typescript",
    source: "src/service.ts",
    test: "src/service.test.ts",
    docs: "docs/service.md",
    config: "config/service.yaml",
    manifest: "config/dependencies.json",
  },
  {
    id: "python",
    source: "app/service.py",
    test: "app/test_service.py",
    docs: "docs/service.md",
    config: "config/service.yaml",
    manifest: "config/dependencies.json",
  },
  {
    id: "go",
    source: "internal/service/service.go",
    test: "internal/service/service_test.go",
    docs: "docs/service.md",
    config: "config/service.yaml",
    manifest: "config/dependencies.json",
  },
];

const FEATURES: readonly [string, ...string[]] = [
  "rateLimit",
  "auditLog",
  "session",
  "webhook",
  "billing",
  "search",
  "invite",
  "dataExport",
  "notification",
  "cache",
];

const DEPENDENCIES: readonly [string, ...string[]] = [
  "zod",
  "lodash",
  "axios",
  "rxjs",
  "date-fns",
  "immer",
  "uuid",
  "pino",
];

interface AllocationEntry {
  readonly id: string;
  readonly category: CalibrationCategory;
  readonly difficulty: CalibrationDifficulty;
  readonly scope: CalibrationLabel;
  readonly complexity: CalibrationLabel;
  readonly weight: number;
}

const ALLOCATION: readonly AllocationEntry[] = [
  // no violation / no violation
  {
    id: "q1-requested-direct-clear",
    category: "requested-direct",
    difficulty: "clear",
    scope: "NO_VIOLATION",
    complexity: "NO_VIOLATION",
    weight: 4,
  },
  {
    id: "q1-necessary-test-clear",
    category: "necessary-test",
    difficulty: "clear",
    scope: "NO_VIOLATION",
    complexity: "NO_VIOLATION",
    weight: 4,
  },
  {
    id: "q1-necessary-error-handling-clear",
    category: "necessary-error-handling",
    difficulty: "clear",
    scope: "NO_VIOLATION",
    complexity: "NO_VIOLATION",
    weight: 4,
  },
  {
    id: "q1-necessary-validation-clear",
    category: "necessary-validation",
    difficulty: "clear",
    scope: "NO_VIOLATION",
    complexity: "NO_VIOLATION",
    weight: 4,
  },
  {
    id: "q1-necessary-supporting-change-clear",
    category: "necessary-supporting-change",
    difficulty: "clear",
    scope: "NO_VIOLATION",
    complexity: "NO_VIOLATION",
    weight: 4,
  },
  {
    id: "q1-existing-pattern-clear",
    category: "existing-pattern",
    difficulty: "clear",
    scope: "NO_VIOLATION",
    complexity: "NO_VIOLATION",
    weight: 5,
  },
  {
    id: "q1-explicitly-required-complexity-clear",
    category: "explicitly-required-complexity",
    difficulty: "clear",
    scope: "NO_VIOLATION",
    complexity: "NO_VIOLATION",
    weight: 5,
  },
  {
    id: "q1-incidental-edit-borderline",
    category: "incidental-edit",
    difficulty: "borderline",
    scope: "NO_VIOLATION",
    complexity: "NO_VIOLATION",
    weight: 4,
  },
  {
    id: "q1-necessary-supporting-change-borderline",
    category: "necessary-supporting-change",
    difficulty: "borderline",
    scope: "NO_VIOLATION",
    complexity: "NO_VIOLATION",
    weight: 3,
  },
  {
    id: "q1-requested-direct-borderline",
    category: "requested-direct",
    difficulty: "borderline",
    scope: "NO_VIOLATION",
    complexity: "NO_VIOLATION",
    weight: 3,
  },
  // violation / no violation
  {
    id: "q2-unrequested-functional-clear",
    category: "unrequested-functional",
    difficulty: "clear",
    scope: "VIOLATION",
    complexity: "NO_VIOLATION",
    weight: 12,
  },
  {
    id: "q2-unrequested-dependency-config-docs-clear",
    category: "unrequested-dependency-config-docs",
    difficulty: "clear",
    scope: "VIOLATION",
    complexity: "NO_VIOLATION",
    weight: 8,
  },
  {
    id: "q2-unrequested-refactor-clear",
    category: "unrequested-refactor",
    difficulty: "clear",
    scope: "VIOLATION",
    complexity: "NO_VIOLATION",
    weight: 10,
  },
  {
    id: "q2-unrequested-functional-borderline",
    category: "unrequested-functional",
    difficulty: "borderline",
    scope: "VIOLATION",
    complexity: "NO_VIOLATION",
    weight: 5,
  },
  {
    id: "q2-unrequested-dependency-config-docs-borderline",
    category: "unrequested-dependency-config-docs",
    difficulty: "borderline",
    scope: "VIOLATION",
    complexity: "NO_VIOLATION",
    weight: 5,
  },
  // no violation / violation
  {
    id: "q3-unnecessary-abstraction-clear",
    category: "unnecessary-abstraction",
    difficulty: "clear",
    scope: "NO_VIOLATION",
    complexity: "VIOLATION",
    weight: 12,
  },
  {
    id: "q3-premature-generalization-clear",
    category: "premature-generalization",
    difficulty: "clear",
    scope: "NO_VIOLATION",
    complexity: "VIOLATION",
    weight: 10,
  },
  {
    id: "q3-excessive-indirection-clear",
    category: "excessive-indirection",
    difficulty: "clear",
    scope: "NO_VIOLATION",
    complexity: "VIOLATION",
    weight: 8,
  },
  {
    id: "q3-unnecessary-abstraction-borderline",
    category: "unnecessary-abstraction",
    difficulty: "borderline",
    scope: "NO_VIOLATION",
    complexity: "VIOLATION",
    weight: 5,
  },
  {
    id: "q3-premature-generalization-borderline",
    category: "premature-generalization",
    difficulty: "borderline",
    scope: "NO_VIOLATION",
    complexity: "VIOLATION",
    weight: 5,
  },
  // violation / violation
  {
    id: "q4-mixed-unrequested-overengineering-clear",
    category: "mixed-unrequested-overengineering",
    difficulty: "clear",
    scope: "VIOLATION",
    complexity: "VIOLATION",
    weight: 10,
  },
  {
    id: "q4-unrequested-refactor-clear",
    category: "unrequested-refactor",
    difficulty: "clear",
    scope: "VIOLATION",
    complexity: "VIOLATION",
    weight: 8,
  },
  {
    id: "q4-unrequested-dependency-config-docs-clear",
    category: "unrequested-dependency-config-docs",
    difficulty: "clear",
    scope: "VIOLATION",
    complexity: "VIOLATION",
    weight: 6,
  },
  {
    id: "q4-unrequested-functional-clear",
    category: "unrequested-functional",
    difficulty: "clear",
    scope: "VIOLATION",
    complexity: "VIOLATION",
    weight: 6,
  },
  {
    id: "q4-mixed-unrequested-overengineering-borderline",
    category: "mixed-unrequested-overengineering",
    difficulty: "borderline",
    scope: "VIOLATION",
    complexity: "VIOLATION",
    weight: 5,
  },
  {
    id: "q4-unrequested-refactor-borderline",
    category: "unrequested-refactor",
    difficulty: "borderline",
    scope: "VIOLATION",
    complexity: "VIOLATION",
    weight: 5,
  },
];

export function allocationEntries(): readonly AllocationEntry[] {
  return ALLOCATION;
}

interface BuildContext {
  readonly entry: AllocationEntry;
  readonly variant: number;
  readonly name: string;
  readonly language: Language;
}

/** FNV-1a 32-bit hash used to seed the deterministic PRNG from a string seed. */
function hashSeed(seed: string): number {
  let hash = 0x811c9dc5;

  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return hash >>> 0;
}

/** Mulberry32: small, fast, fully deterministic for one integer seed. */
function createRandom(seed: string): () => number {
  let state = hashSeed(seed);

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);

    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(values: readonly [T, ...T[]], index: number): T {
  return values[index % values.length] ?? values[0];
}

function pascal(value: string): string {
  return value.length === 0 ? value : `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

function snake(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

function indent(lines: readonly string[], unit: string): readonly string[] {
  return lines.map((line) => (line === "" ? "" : `${unit}${line}`));
}

interface Language {
  readonly profile: LanguageProfile;
  readonly normalizeBody: readonly string[];
  readonly normalizeReturn: string;
  readonly errorBody: readonly string[];
  readonly validationBody: readonly string[];
  code(name: string, body: readonly string[], returnExpression: string): readonly string[];
  testFor(name: string): readonly string[];
  doc(note: string): readonly string[];
  configFor(entries: readonly string[]): readonly string[];
  manifestFor(dependencies: Readonly<Record<string, string>>): readonly string[];
  interfaceFile(name: string): readonly string[];
  registry(name: string, keys: readonly string[]): readonly string[];
  helperName(name: string): string;
  helperFile(name: string): readonly string[];
  structure(kind: StructureKind, name: string): readonly string[];
  call(name: string): string;
  file(name: string, suffix: string): string;
}

function typeScriptHelper(name: string): string {
  return `normalize${pascal(name)}`;
}

function pythonHelper(name: string): string {
  return `normalize_${snake(name)}`;
}

function goHelper(name: string): string {
  return `Normalize${pascal(name)}`;
}

function createLanguage(profile: LanguageProfile): Language {
  switch (profile.id) {
    case "typescript":
      return createTypeScriptLanguage(profile);
    case "python":
      return createPythonLanguage(profile);
    case "go":
      return createGoLanguage(profile);
  }
}

function createTypeScriptLanguage(profile: LanguageProfile): Language {
  return {
    profile,
    normalizeBody: ["const normalized = value.trim();"],
    normalizeReturn: "normalized",
    errorBody: ["if (value.length === 0) {", '  throw new Error("empty value");', "}"],
    validationBody: ['if (!value.startsWith("ok")) {', '  throw new Error("invalid value");', "}"],
    code(name, body, returnExpression) {
      return [
        `export function ${name}(value: string): string {`,
        ...indent(body, "  "),
        `  return ${returnExpression};`,
        "}",
      ];
    },
    testFor(name) {
      return [
        'import { describe, expect, it } from "vitest";',
        `import { ${name} } from "./service";`,
        "",
        `describe("${name}", () => {`,
        '  it("handles a value", () => {',
        `    expect(${name}("ok")).toBe("ok");`,
        "  });",
        "});",
      ];
    },
    doc(note) {
      return [`# ${note}`, "", `Notes for ${note}.`];
    },
    configFor(entries) {
      return ["service:", ...indent(entries, "  ")];
    },
    manifestFor(dependencies) {
      return ["{", '  "dependencies": {', ...formatJsonEntries(dependencies, "    "), "  }", "}"];
    },
    interfaceFile(name) {
      return [
        `export interface ${pascal(name)} {`,
        "  readonly id: string;",
        "  readonly retries: number;",
        "}",
      ];
    },
    registry(name, keys) {
      return [
        `export const ${name}Registry = new Map<string, () => void>([`,
        ...keys.map((key) => `  ["${key}", () => undefined],`),
        "]);",
      ];
    },
    helperName: typeScriptHelper,
    helperFile(name) {
      return [
        `export function ${typeScriptHelper(name)}(value: string): string {`,
        "  return value.trim();",
        "}",
      ];
    },
    structure(kind, name) {
      return tsStructure(kind, name);
    },
    call(name) {
      return `${name}(value)`;
    },
    file(name, suffix) {
      return `src/${name}-${suffix}.ts`;
    },
  };
}

function tsStructure(kind: StructureKind, name: string): readonly string[] {
  const typeName = pascal(name);

  switch (kind) {
    case "factory":
      return [
        `export class ${typeName} {`,
        "  constructor(private readonly kind: string) {}",
        "",
        "  execute(): void {",
        `    throw new Error("not implemented");`,
        "  }",
        "}",
        "",
        `export function create${typeName}(kind: string): ${typeName} {`,
        `  return new ${typeName}(kind);`,
        "}",
      ];
    case "registry":
      return [
        `export const ${name}Registry = new Map<string, () => void>();`,
        "",
        `export function register${typeName}(key: string, factory: () => void): void {`,
        `  ${name}Registry.set(key, factory);`,
        "}",
      ];
    case "pipeline":
      return [
        `export interface ${typeName}Stage {`,
        "  run(input: string): string;",
        "}",
        "",
        `export function run${typeName}Pipeline(`,
        `  stages: readonly ${typeName}Stage[],`,
        "  input: string,",
        "): string {",
        "  return stages.reduce((value, stage) => stage.run(value), input);",
        "}",
      ];
    case "interface":
      return [
        `export interface ${typeName} {`,
        "  readonly id: string;",
        "  execute(): void;",
        "}",
      ];
    case "bus":
      return [
        `type ${typeName}Listener = (payload: string) => void;`,
        "",
        `export class ${typeName}Bus {`,
        `  private readonly listeners = new Set<${typeName}Listener>();`,
        "",
        `  subscribe(listener: ${typeName}Listener): void {`,
        "    this.listeners.add(listener);",
        "  }",
        "",
        "  publish(payload: string): void {",
        "    for (const listener of this.listeners) {",
        "      listener(payload);",
        "    }",
        "  }",
        "}",
      ];
    case "layer":
      return [
        `export function ${name}Layer(input: string): string {`,
        `  return ${name}Delegate(input);`,
        "}",
        "",
        `function ${name}Delegate(input: string): string {`,
        "  return input;",
        "}",
      ];
  }
}

function createPythonLanguage(profile: LanguageProfile): Language {
  return {
    profile,
    normalizeBody: ["normalized = value.strip()"],
    normalizeReturn: "normalized",
    errorBody: ["if not value:", '    raise ValueError("empty value")'],
    validationBody: ['if not value.startswith("ok"):', '    raise ValueError("invalid value")'],
    code(name, body, returnExpression) {
      return [pythonFunction(name), ...indent(body, "    "), `    return ${returnExpression}`];
    },
    testFor(name) {
      return [`def test_${snake(name)}() -> None:`, `    assert ${snake(name)}("ok") == "ok"`];
    },
    doc(note) {
      return [`# ${note}`, "", `Notes for ${note}.`];
    },
    configFor(entries) {
      return ["service:", ...indent(entries, "  ")];
    },
    manifestFor(dependencies) {
      return ["{", '  "dependencies": {', ...formatJsonEntries(dependencies, "    "), "  }", "}"];
    },
    interfaceFile(name) {
      return [
        "from dataclasses import dataclass",
        "",
        "@dataclass",
        `class ${pascal(name)}:`,
        "    id: str",
        "    retries: int",
      ];
    },
    registry(name, keys) {
      return [
        `${snake(name)}_registry = {`,
        ...keys.map((key) => `    "${key}": lambda: None,`),
        "}",
      ];
    },
    helperName: pythonHelper,
    helperFile(name) {
      return [pythonFunction(pythonHelper(name)), "    return value.strip()"];
    },
    structure(kind, name) {
      return pyStructure(kind, name);
    },
    call(name) {
      return `${snake(name)}(value)`;
    },
    file(name, suffix) {
      return `app/${snake(name)}_${snake(suffix)}.py`;
    },
  };
}

function pythonFunction(name: string): string {
  return `def ${snake(name)}(value: str) -> str:`;
}

function pyStructure(kind: StructureKind, name: string): readonly string[] {
  const typeName = pascal(name);

  switch (kind) {
    case "factory":
      return [
        `class ${typeName}:`,
        "    def __init__(self, kind: str) -> None:",
        "        self.kind = kind",
        "",
        "    def execute(self) -> None:",
        "        raise NotImplementedError",
        "",
        "",
        `def create_${snake(name)}(kind: str) -> ${typeName}:`,
        `    return ${typeName}(kind)`,
      ];
    case "registry":
      return [
        `${snake(name)}_registry = {}`,
        "",
        "",
        `def register_${snake(name)}(key: str, factory) -> None:`,
        `    ${snake(name)}_registry[key] = factory`,
      ];
    case "pipeline":
      return [
        `class ${typeName}Stage:`,
        "    def run(self, value: str) -> str:",
        "        raise NotImplementedError",
        "",
        "",
        `def run_${snake(name)}_pipeline(stages, value: str) -> str:`,
        "    for stage in stages:",
        "        value = stage.run(value)",
        "    return value",
      ];
    case "interface":
      return [
        `class ${typeName}:`,
        "    id: str",
        "",
        "    def execute(self) -> None:",
        "        raise NotImplementedError",
      ];
    case "bus":
      return [
        `class ${typeName}Bus:`,
        "    def __init__(self) -> None:",
        "        self.listeners = []",
        "",
        "    def subscribe(self, listener) -> None:",
        "        self.listeners.append(listener)",
        "",
        "    def publish(self, payload: str) -> None:",
        "        for listener in self.listeners:",
        "            listener(payload)",
      ];
    case "layer":
      return [
        `def ${snake(name)}_layer(value: str) -> str:`,
        `    return ${snake(name)}_delegate(value)`,
        "",
        "",
        `def ${snake(name)}_delegate(value: str) -> str:`,
        "    return value",
      ];
  }
}

function createGoLanguage(profile: LanguageProfile): Language {
  return {
    profile,
    normalizeBody: ["normalized := strings.TrimSpace(value)"],
    normalizeReturn: "normalized",
    errorBody: ['if value == "" {', '\treturn ""', "}"],
    validationBody: ['if !strings.HasPrefix(value, "ok") {', '\treturn ""', "}"],
    code(name, body, returnExpression) {
      return [
        "package service",
        "",
        'import "strings"',
        "",
        `func ${pascal(name)}(value string) string {`,
        ...indent(body, "\t"),
        `\treturn ${returnExpression}`,
        "}",
      ];
    },
    testFor(name) {
      return [
        "package service",
        "",
        'import "testing"',
        "",
        `func Test${pascal(name)}(t *testing.T) {`,
        `\tif ${pascal(name)}("ok") != "ok" {`,
        '\t\tt.Fatalf("unexpected result")',
        "\t}",
        "}",
      ];
    },
    doc(note) {
      return [`# ${note}`, "", `Notes for ${note}.`];
    },
    configFor(entries) {
      return ["service:", ...indent(entries, "  ")];
    },
    manifestFor(dependencies) {
      return ["{", '  "dependencies": {', ...formatJsonEntries(dependencies, "    "), "  }", "}"];
    },
    interfaceFile(name) {
      return [
        "package service",
        "",
        `type ${pascal(name)} struct {`,
        "\tID string",
        "\tRetries int",
        "}",
      ];
    },
    registry(name, keys) {
      return [
        "package service",
        "",
        `var ${pascal(name)}Registry = map[string]func(){`,
        ...keys.map((key) => `\t"${key}": func() {},`),
        "}",
      ];
    },
    helperName: goHelper,
    helperFile(name) {
      return [
        "package service",
        "",
        'import "strings"',
        "",
        `func ${goHelper(name)}(value string) string {`,
        "\treturn strings.TrimSpace(value)",
        "}",
      ];
    },
    structure(kind, name) {
      return goStructure(kind, name);
    },
    call(name) {
      return `${pascal(name)}(value)`;
    },
    file(name, suffix) {
      return `internal/service/${snake(name)}_${snake(suffix)}.go`;
    },
  };
}

function goStructure(kind: StructureKind, name: string): readonly string[] {
  const typeName = pascal(name);

  switch (kind) {
    case "factory":
      return [
        "package service",
        "",
        `type ${typeName} struct {`,
        "\tkind string",
        "}",
        "",
        `func Create${typeName}(kind string) ${typeName} {`,
        `\treturn ${typeName}{kind: kind}`,
        "}",
      ];
    case "registry":
      return [
        "package service",
        "",
        `var ${pascal(name)}Registry = map[string]func(){}`,
        "",
        `func Register${typeName}(key string, factory func()) {`,
        `\t${pascal(name)}Registry[key] = factory`,
        "}",
      ];
    case "pipeline":
      return [
        "package service",
        "",
        `type ${typeName}Stage interface {`,
        "\tRun(input string) string",
        "}",
        "",
        `func Run${typeName}Pipeline(stages []${typeName}Stage, input string) string {`,
        "\tfor _, stage := range stages {",
        "\t\tinput = stage.Run(input)",
        "\t}",
        "\treturn input",
        "}",
      ];
    case "interface":
      return ["package service", "", `type ${typeName} interface {`, "\tExecute()", "}"];
    case "bus":
      return [
        "package service",
        "",
        `type ${typeName}Bus struct {`,
        "\tlisteners []func(string)",
        "}",
        "",
        `func (bus *${typeName}Bus) Subscribe(listener func(string)) {`,
        "\tbus.listeners = append(bus.listeners, listener)",
        "}",
        "",
        `func (bus *${typeName}Bus) Publish(payload string) {`,
        "\tfor _, listener := range bus.listeners {",
        "\t\tlistener(payload)",
        "\t}",
        "}",
      ];
    case "layer":
      return [
        "package service",
        "",
        `func ${typeName}Layer(input string) string {`,
        `\treturn ${typeName}Delegate(input)`,
        "}",
        "",
        `func ${typeName}Delegate(input string) string {`,
        "\treturn input",
        "}",
      ];
  }
}

function formatJsonEntries(
  dependencies: Readonly<Record<string, string>>,
  unit: string,
): readonly string[] {
  const entries = Object.entries(dependencies);

  return entries.map(
    ([name, version], index) =>
      `${unit}"${name}": "${version}"${index === entries.length - 1 ? "" : ","}`,
  );
}

function revision(path: string, before: readonly string[], after: readonly string[]): Revision {
  return { path, before, after };
}

function toTurnFile(revisionValue: Revision): TurnFile {
  const { path, before, after } = revisionValue;
  const prefix = commonPrefix(before, after);
  const suffix = commonSuffix(before, after, prefix);
  const contextBefore = before.slice(0, prefix);
  const removed = before.slice(prefix, before.length - suffix);
  const added = after.slice(prefix, after.length - suffix);
  const contextAfter = suffix === 0 ? [] : before.slice(before.length - suffix);
  const oldCount = contextBefore.length + removed.length + contextAfter.length;
  const newCount = contextBefore.length + added.length + contextAfter.length;
  const lines = [
    ...contextBefore.map((line) => ` ${line}`),
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
    ...contextAfter.map((line) => ` ${line}`),
  ];
  const oldStart = oldCount === 0 ? 0 : prefix + 1;
  const newStart = newCount === 0 ? 0 : prefix + 1;
  const patch = [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
    ...lines,
  ].join("\n");

  return { path, patch };
}

function commonPrefix(before: readonly string[], after: readonly string[]): number {
  const limit = Math.min(before.length, after.length);
  let prefix = 0;

  while (prefix < limit && before[prefix] === after[prefix]) {
    prefix += 1;
  }

  return prefix;
}

function commonSuffix(before: readonly string[], after: readonly string[], prefix: number): number {
  const limit = Math.min(before.length - prefix, after.length - prefix);
  let suffix = 0;

  while (
    suffix < limit &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  return suffix;
}

interface Scenario {
  readonly task: string;
  readonly revisions: readonly Revision[];
}

function updated(
  language: Language,
  name: string,
  body: readonly string[],
  returnExpression: string,
): Revision {
  return revision(
    language.profile.source,
    language.code(name, [], "value"),
    language.code(name, body, returnExpression),
  );
}

function requestedBehavior(language: Language, name: string): Revision {
  return updated(language, name, language.normalizeBody, language.normalizeReturn);
}

function newFile(
  language: Language,
  name: string,
  suffix: string,
  lines: readonly string[],
): Revision {
  return revision(language.file(name, suffix), [], lines);
}

function buildScenario(context: BuildContext): Scenario {
  const { entry, name, language, variant } = context;

  switch (entry.category) {
    case "requested-direct":
      return {
        task: `Apply ${name} to the incoming value in the service.`,
        revisions: [requestedBehavior(language, name)],
      };
    case "necessary-test":
      return {
        task: `Apply ${name} to the incoming value and cover it with tests.`,
        revisions: [
          requestedBehavior(language, name),
          revision(language.profile.test, [], language.testFor(name)),
        ],
      };
    case "necessary-error-handling":
      return {
        task: `Handle empty input before applying ${name}.`,
        revisions: [updated(language, name, language.errorBody, "value")],
      };
    case "necessary-validation":
      return {
        task: `Validate the incoming value before applying ${name}.`,
        revisions: [updated(language, name, language.validationBody, "value")],
      };
    case "necessary-supporting-change":
      return {
        task: `Add a retries option alongside ${name}.`,
        revisions: [
          newFile(language, name, "options", language.interfaceFile(`${name}Options`)),
          revision(
            language.profile.docs,
            language.doc(`${name} service`),
            language.doc(`${name} service with retries option`),
          ),
        ],
      };
    case "existing-pattern":
      return {
        task: `Register ${name} in the existing handler registry.`,
        revisions: [
          revision(
            language.file(name, "registry"),
            language.registry(name, ["existing"]),
            language.registry(name, ["existing", name]),
          ),
        ],
      };
    case "explicitly-required-complexity":
      return {
        task: `Introduce a staged ${name} pipeline with a stage interface, as the task explicitly requires.`,
        revisions: [
          newFile(language, name, "stage", language.structure("interface", `${name}Stage`)),
          newFile(language, name, "pipeline", language.structure("pipeline", name)),
          newFile(language, name, "layer", language.structure("layer", name)),
        ],
      };
    case "incidental-edit":
      return {
        task: `Apply ${name} and tidy the nearby formatting.`,
        revisions: [
          requestedBehavior(language, name),
          revision(
            language.profile.docs,
            [`# ${name} service`, "", `Notes for ${name} service.  `],
            language.doc(`${name} service`),
          ),
        ],
      };
    case "unrequested-functional":
      return {
        task: `Fix ${name} so it normalizes input correctly.`,
        revisions:
          entry.complexity === "VIOLATION"
            ? [
                requestedBehavior(language, name),
                newFile(
                  language,
                  name,
                  "extra",
                  language.code(`${name}Extra`, language.normalizeBody, "normalized"),
                ),
                newFile(language, `${name}Bus`, "bus", language.structure("bus", name)),
              ]
            : [
                requestedBehavior(language, name),
                newFile(language, name, "extra", language.code(`${name}Extra`, [], "value")),
              ],
      };
    case "unrequested-dependency-config-docs":
      return dependencyScenario(entry, name, language, variant);
    case "unrequested-refactor":
      return entry.complexity === "VIOLATION"
        ? {
            task: `Apply ${name} to the incoming value.`,
            revisions: [
              updated(
                language,
                name,
                [`const normalized = ${language.helperName(name)}(value);`],
                "normalized",
              ),
              newFile(language, name, "helper", language.helperFile(name)),
              newFile(language, name, "layer", language.structure("layer", name)),
              newFile(language, name, "container", language.structure("factory", name)),
            ],
          }
        : {
            task: `Apply ${name} to the incoming value.`,
            revisions: [
              updated(
                language,
                name,
                [`const normalized = ${language.helperName(name)}(value);`],
                "normalized",
              ),
              newFile(language, name, "helper", language.helperFile(name)),
            ],
          };
    case "unnecessary-abstraction":
      return {
        task: `Apply ${name} to the incoming value in a single step.`,
        revisions: [
          newFile(language, name, "factory", language.structure("factory", name)),
          newFile(language, name, "registry", language.structure("registry", name)),
          updated(language, name, [], language.call(`create${pascal(name)}`)),
        ],
      };
    case "premature-generalization":
      return {
        task: `Add support for ${name} using the existing service.`,
        revisions: [
          newFile(language, name, "registry", language.structure("registry", name)),
          newFile(language, name, "plugin", language.structure("interface", `${name}Plugin`)),
          updated(language, name, [], language.call(`register${pascal(name)}`)),
        ],
      };
    case "excessive-indirection":
      return {
        task: `Apply ${name} to the incoming value.`,
        revisions: [
          newFile(language, name, "layer", language.structure("layer", name)),
          newFile(language, name, "delegate", language.structure("layer", `${name}Delegate`)),
          updated(language, name, [], language.call(`${name}Layer`)),
        ],
      };
    case "mixed-unrequested-overengineering":
      return {
        task: `Fix ${name} so it normalizes input correctly.`,
        revisions: [
          requestedBehavior(language, name),
          newFile(language, name, "bus", language.structure("bus", name)),
          newFile(language, name, "container", language.structure("factory", `${name}Factory`)),
          newFile(language, name, "extra", language.code(`${name}Extra`, [], "value")),
        ],
      };
  }
}

function dependencyScenario(
  entry: AllocationEntry,
  name: string,
  language: Language,
  variant: number,
): Scenario {
  const dependency = pick(DEPENDENCIES, variant);
  const heavy = entry.complexity === "VIOLATION";

  const revisions: Revision[] = [
    revision(
      language.profile.docs,
      language.doc(`${name} service`),
      language.doc(`${name} service using ${dependency}`),
    ),
    revision(
      language.profile.manifest,
      language.manifestFor({}),
      language.manifestFor({ [dependency]: "^1.0.0" }),
    ),
    revision(
      language.profile.config,
      language.configFor([`feature: ${name}`]),
      language.configFor([`feature: ${name}`, `${dependency}: enabled`]),
    ),
  ];

  if (heavy) {
    revisions.push(
      newFile(language, name, "factory", language.structure("factory", name)),
      newFile(language, `${name}Bus`, "bus", language.structure("bus", name)),
    );
  }

  return {
    task: `Apply ${name} to the incoming value.`,
    revisions,
  };
}

interface AllocatedEntry {
  readonly entry: AllocationEntry;
  readonly count: number;
}

function allocateCounts(total: number): readonly AllocatedEntry[] {
  const totalWeight = ALLOCATION.reduce((sum, entry) => sum + entry.weight, 0);
  const exact = ALLOCATION.map((entry) => ({
    entry,
    value: (total * entry.weight) / totalWeight,
  }));
  const base = exact.map((item) => ({
    entry: item.entry,
    count: Math.floor(item.value),
    remainder: item.value - Math.floor(item.value),
  }));
  const assigned = base.reduce((sum, item) => sum + item.count, 0);
  const remaining = total - assigned;

  if (remaining > 0) {
    const order = [...base].sort(
      (left, right) =>
        right.remainder - left.remainder || left.entry.id.localeCompare(right.entry.id),
    );

    for (let index = 0; index < remaining; index += 1) {
      const item = order[index % order.length];

      if (item !== undefined) {
        item.count += 1;
      }
    }
  }

  return base.map((item) => ({ entry: item.entry, count: item.count }));
}

function fixtureId(entry: AllocationEntry, index: number): string {
  return `${entry.id}-${String(index + 1).padStart(3, "0")}`;
}

function fixtureFor(
  entry: AllocationEntry,
  variant: number,
  seed: string,
): SyntheticCalibrationFixture {
  const random = createRandom(`${seed}:${entry.id}:${variant}`);
  const nameIndex = Math.floor(random() * FEATURES.length);
  const name = pick(FEATURES, nameIndex + variant);
  const language = createLanguage(pick(LANGUAGES, variant + entry.id.length));
  const scenario = buildScenario({ entry, variant, name, language });

  return {
    schemaVersion: 1,
    id: fixtureId(entry, variant),
    provenance: "synthetic-author",
    category: entry.category,
    difficulty: entry.difficulty,
    task: scenario.task,
    files: scenario.revisions.map(toTurnFile),
    expected: { scopeCreep: entry.scope, complexity: entry.complexity },
  };
}

/**
 * Builds the deterministic synthetic corpus. The scenario family assigns both
 * labels, independent of Jev; the output is byte-identical for a fixed seed and
 * count, and entries are interleaved so a limited run is not a biased prefix.
 */
export function buildFixtures(seed: string, count: number): readonly SyntheticCalibrationFixture[] {
  const allocated = allocateCounts(count);
  const perEntry = allocated.map((item) =>
    Array.from({ length: item.count }, (_unused, variant) => fixtureFor(item.entry, variant, seed)),
  );
  const ordered: SyntheticCalibrationFixture[] = [];
  let round = 0;
  let added = true;

  while (added) {
    added = false;

    for (const list of perEntry) {
      const fixture = list[round];

      if (fixture !== undefined) {
        ordered.push(fixture);
        added = true;
      }
    }

    round += 1;
  }

  return ordered;
}
