import type { OpenCodePart } from "./types";

export function extractTask(parts: readonly OpenCodePart[]): string | null {
  const task = parts
    .filter(isTextPart)
    .map((part) => part.text)
    .join("\n");

  return task.trim() === "" ? null : task;
}

function isTextPart(part: OpenCodePart): part is OpenCodePart & { readonly text: string } {
  return part.type === "text" && typeof part.text === "string";
}
