import { readFile, stat } from "node:fs/promises";
import type { DiffRead, DiffSource } from "./types";

export const MAX_DIFF_INPUT_BYTES = 16 * 1024 * 1024;

const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });

/**
 * Node implementation of the diff input port. It reads a regular file or piped stdin
 * as strict UTF-8, enforces the size bound, refuses an interactive terminal on stdin, and
 * never throws.
 */
export function createNodeDiffReader(): (source: DiffSource) => Promise<DiffRead> {
  return async (source) => {
    try {
      return source.kind === "FILE" ? await readDiffFile(source.path) : await readDiffStdin();
    } catch {
      return { status: "FAILED", reason: "DIFF_READ_FAILURE" };
    }
  };
}

async function readDiffFile(path: string): Promise<DiffRead> {
  const info = await stat(path);

  if (!info.isFile()) {
    return { status: "FAILED", reason: "DIFF_READ_FAILURE" };
  }

  if (info.size > MAX_DIFF_INPUT_BYTES) {
    return { status: "FAILED", reason: "DIFF_TOO_LARGE" };
  }

  return decodeDiff(await readFile(path));
}

async function readDiffStdin(): Promise<DiffRead> {
  if (process.stdin.isTTY === true) {
    return { status: "FAILED", reason: "STDIN_IS_TTY" };
  }

  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += buffer.length;

    if (total > MAX_DIFF_INPUT_BYTES) {
      return { status: "FAILED", reason: "DIFF_TOO_LARGE" };
    }

    chunks.push(buffer);
  }

  return decodeDiff(Buffer.concat(chunks));
}

function decodeDiff(bytes: Uint8Array): DiffRead {
  try {
    return { status: "READ", text: STRICT_UTF8.decode(bytes) };
  } catch {
    return { status: "FAILED", reason: "DIFF_NOT_UTF8" };
  }
}
