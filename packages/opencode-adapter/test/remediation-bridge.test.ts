import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/client";
import { describe, expect, test } from "vitest";
import { createOpenCodeCommandClient, createOpenCodeReviewBridge } from "../src/index";

interface CapturedRequest {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

interface RecordingClient {
  readonly client: OpencodeClient;
  readonly requests: CapturedRequest[];
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function errorResponse(status: number): Response {
  return new Response(JSON.stringify({ name: "BadRequestError", data: { message: "bad" } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function recordingClient(respond: () => Promise<Response>): RecordingClient {
  const requests: CapturedRequest[] = [];

  const client = createOpencodeClient({
    baseUrl: "http://opencode.test",
    fetch: async (request) => {
      const url = new URL(request.url);
      const text = await request.text();

      requests.push({
        method: request.method,
        path: url.pathname,
        body: text === "" ? null : JSON.parse(text),
      });

      return respond();
    },
  });

  return { client, requests };
}

const COMMAND = "jevguard.review.v1:eyJ2ZXJzaW9uIjoxfQ";

describe("createOpenCodeReviewBridge", () => {
  test("sends the exact SDK execute-command request and reports delivered", async () => {
    const { client, requests } = recordingClient(() => Promise.resolve(jsonResponse(true)));
    const bridge = createOpenCodeReviewBridge(createOpenCodeCommandClient(client));

    const status = await bridge.execute(COMMAND);

    expect(status).toBe("DELIVERED");
    expect(requests).toEqual([
      { method: "POST", path: "/tui/execute-command", body: { command: COMMAND } },
    ]);
  });

  test("maps an SDK error response to FAILED", async () => {
    const { client } = recordingClient(() => Promise.resolve(errorResponse(400)));
    const bridge = createOpenCodeReviewBridge(createOpenCodeCommandClient(client));

    await expect(bridge.execute(COMMAND)).resolves.toBe("FAILED");
  });

  test("maps a rejected request to FAILED without throwing", async () => {
    const { client } = recordingClient(() => Promise.reject(new Error("network down")));
    const bridge = createOpenCodeReviewBridge(createOpenCodeCommandClient(client));

    await expect(bridge.execute(COMMAND)).resolves.toBe("FAILED");
  });
});
