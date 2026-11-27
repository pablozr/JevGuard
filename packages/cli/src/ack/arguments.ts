import type { AckArguments } from "./types";

const NUMBER_PATTERN = /^[1-9][0-9]{0,3}$/;

/**
 * Parses the arguments after `ack`: nothing lists, `<number>` acknowledges that unit.
 * There is no non-interactive form and no flag skips the confirmation; any other
 * argument is usage, and no value is ever echoed.
 */
export function parseAckArguments(args: readonly string[]): AckArguments {
  if (args.length === 0) {
    return { kind: "LIST" };
  }

  const [number] = args;

  if (args.length !== 1 || number === undefined || !NUMBER_PATTERN.test(number)) {
    return { kind: "USAGE" };
  }

  return { kind: "ACK", number: Number(number) };
}
