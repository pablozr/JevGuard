export type JsonRecord = Readonly<Record<string, unknown>>;

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True when `record` has every `required` key and no key outside `required` and `optional`. */
export function hasKeys(
  record: JsonRecord,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(record);

  return (
    required.every((key) => keys.includes(key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
}
