const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** UTF-8 byte length of a string without host-specific encoding APIs. */
export function utf8ByteLength(text: string): number {
  return utf8Bytes(text).length;
}

/** Base64url encoding of a string's UTF-8 bytes, without padding. */
export function encodeBase64Url(text: string): string {
  return encodeBytesAsBase64Url(utf8Bytes(text));
}

function utf8Bytes(text: string): readonly number[] {
  const bytes: number[] = [];

  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;

    if (codePoint <= 0x7f) {
      bytes.push(codePoint);
    } else if (codePoint <= 0x7ff) {
      bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint <= 0xffff) {
      bytes.push(
        0xe0 | (codePoint >> 12),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    } else {
      bytes.push(
        0xf0 | (codePoint >> 18),
        0x80 | ((codePoint >> 12) & 0x3f),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    }
  }

  return bytes;
}

function encodeBytesAsBase64Url(bytes: readonly number[]): string {
  let output = "";

  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    const chunk = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);

    output += BASE64URL_ALPHABET.charAt((chunk >> 18) & 0x3f);
    output += BASE64URL_ALPHABET.charAt((chunk >> 12) & 0x3f);

    if (second === undefined) {
      break;
    }

    output += BASE64URL_ALPHABET.charAt((chunk >> 6) & 0x3f);

    if (third === undefined) {
      break;
    }

    output += BASE64URL_ALPHABET.charAt(chunk & 0x3f);
  }

  return output;
}
