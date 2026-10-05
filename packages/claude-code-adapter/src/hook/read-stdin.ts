export const MAX_STDIN_BYTES = 16 * 1024 * 1024;

/** The whole stream as text, or `null` once it exceeds `maxBytes`; never buffers past it. */
export async function readLimitedStdin(
  stream: AsyncIterable<Uint8Array | string>,
  maxBytes: number = MAX_STDIN_BYTES,
): Promise<string | null> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of stream) {
    const buffer = Buffer.from(chunk);

    total += buffer.length;

    if (total > maxBytes) return null;

    chunks.push(buffer);
  }

  return Buffer.concat(chunks).toString("utf8");
}
