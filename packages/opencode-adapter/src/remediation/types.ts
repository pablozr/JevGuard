export type BridgeCommandDelivery = "DELIVERED" | "FAILED";

/**
 * Narrow write-only port for the internal review bridge command. Implementations own
 * the host transport; a failure is returned as `FAILED` and is never thrown.
 */
export interface ReviewBridgePort {
  execute(command: string): Promise<BridgeCommandDelivery>;
}

export interface OpenCodeExecuteCommandInput {
  readonly body: {
    readonly command: string;
  };
}

export interface OpenCodeExecuteCommandResult {
  readonly error?: unknown;
}

/**
 * Narrow OpenCode client surface for bridge commands. Structural typing keeps the
 * adapter decoupled from the SDK runtime and lets tests fake command delivery.
 */
export interface OpenCodeCommandClient {
  readonly tui: {
    executeCommand(input: OpenCodeExecuteCommandInput): Promise<OpenCodeExecuteCommandResult>;
  };
}
