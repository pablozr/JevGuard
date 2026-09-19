import { type Document, parseDocument, visit } from "yaml";
import type { ConfigParseResult } from "./types";

/**
 * Parses optional policy config without trusting its shape. Multi-document,
 * duplicate-key, empty, warning-producing, anchor, alias, and explicitly tagged
 * YAML is rejected; the returned value is a plain unknown for the core validator.
 */
export function parsePolicyConfig(text: string): ConfigParseResult {
  const document = parseDocument(text, { strict: true, uniqueKeys: true });

  if (document.errors.length > 0 || document.warnings.length > 0) {
    return invalid();
  }

  if (document.contents === null || containsAliasAnchorOrTag(document)) {
    return invalid();
  }

  try {
    return { status: "PARSED", value: document.toJS({ maxAliasCount: 0 }) };
  } catch {
    return invalid();
  }
}

function containsAliasAnchorOrTag(document: Document): boolean {
  let unsafe = false;

  visit(document, {
    Alias() {
      unsafe = true;
      return visit.BREAK;
    },
    Node(_key, node) {
      if (node.anchor !== undefined || node.tag !== undefined) {
        unsafe = true;
        return visit.BREAK;
      }
    },
  });

  return unsafe;
}

function invalid(): ConfigParseResult {
  return { status: "INVALID", reason: "INVALID_CONFIG" };
}
