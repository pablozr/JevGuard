import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/client";
import { describe, expect, test } from "vitest";
import { createOpenCodePresentationClient, createOpenCodeSessionNavigator } from "../src/index";

interface CapturedRequest {
  readonly method: string;
  readonly path: string;
  readonly body: string;
}

interface RecordingClient {
  readonly client: OpencodeClient;
  readonly requests: CapturedRequest[];
}

function recordingClient(respond: (request: Request) => Promise<Response>): RecordingClient {
  const requests: CapturedRequest[] = [];

  const client = createOpencodeClient({
    baseUrl: "http://opencode.test",
    fetch: async (request) => {
      const url = new URL(request.url);
      const body = request.method === "GET" ? "" : await request.text();

      requests.push({ method: request.method, path: url.pathname, body });

      return respond(request);
    },
  });

  return { client, requests };
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

describe("createOpenCodeSessionNavigator", () => {
  test("publishes the exact tui.session.select event for the child session", async () => {
    const { client, requests } = recordingClient(() => Promise.resolve(jsonResponse(true)));

    const status = await createOpenCodeSessionNavigator(
      createOpenCodePresentationClient(client),
    ).navigate("ses_child");

    expect(status).toBe("DELIVERED");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.path).toBe("/tui/publish");
    expect(JSON.parse(requests[0]?.body ?? "{}")).toEqual({
      type: "tui.session.select",
      properties: { sessionID: "ses_child" },
    });
  });

  test("contains an error result as FAILED and never throws", async () => {
    const { client } = recordingClient(() => Promise.resolve(errorResponse(400)));

    await expect(
      createOpenCodeSessionNavigator(createOpenCodePresentationClient(client)).navigate(
        "ses_child",
      ),
    ).resolves.toBe("FAILED");
  });

  test("contains a rejected request as FAILED and never throws", async () => {
    const { client } = recordingClient(() => Promise.reject(new Error("connection reset")));

    await expect(
      createOpenCodeSessionNavigator(createOpenCodePresentationClient(client)).navigate(
        "ses_child",
      ),
    ).resolves.toBe("FAILED");
  });
});
