const RULE_HEADING = /^##\s+(.*)$/;
const SECTION_HEADING = /^###\s+(.*)$/;

export function matchRuleHeading(line: string): string | null {
  const match = RULE_HEADING.exec(line);

  if (match === null) {
    return null;
  }

  return (match[1] ?? "").trim();
}

export function matchSectionHeading(line: string): string | null {
  const match = SECTION_HEADING.exec(line);

  if (match === null) {
    return null;
  }

  return (match[1] ?? "").trim();
}
