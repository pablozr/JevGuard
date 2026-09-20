import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/client";
import { describe, expect, test } from "vitest";
import { createOpenCodeSessionFacade } from "../src/index";

interface CapturedRequest {
  readonly method: string;
  readonly path: string;
  readonly query: string;
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
      requests.push({ method: request.method, path: url.pathname, query: url.search });

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
  return new Response(JSON.stringify({ name: "NotFoundError", data: { message: "missing" } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("createOpenCodeSessionFacade", () => {
  test("lists messages from the session messages endpoint and unwraps data", async () => {
    const records = [
      { info: { id: "msg_u1", role: "user" }, parts: [{ type: "text", text: "task" }] },
    ];
    const { client, requests } = recordingClient(() => Promise.resolve(jsonResponse(records)));

    const result = await createOpenCodeSessionFacade(client).listMessages({ sessionID: "ses_1" });

    expect(requests).toEqual([{ method: "GET", path: "/session/ses_1/message", query: "" }]);
    expect(result).toEqual(records);
  });

  test("forwards the supplied message id to the session diff endpoint", async () => {
    const diffs = [{ file: "src/auth.ts", before: "", after: "patch" }];
    const { client, requests } = recordingClient(() => Promise.resolve(jsonResponse(diffs)));

    const result = await createOpenCodeSessionFacade(client).fetchDiff({
      sessionID: "ses_1",
      messageID: "msg_user_parent",
    });

    expect(requests).toEqual([
      { method: "GET", path: "/session/ses_1/diff", query: "?messageID=msg_user_parent" },
    ]);
    expect(result).toEqual(diffs);
  });

  test("rejects listMessages when the SDK request promise rejects", async () => {
    const { client } = recordingClient(() => Promise.reject(new Error("network down")));

    await expect(
      createOpenCodeSessionFacade(client).listMessages({ sessionID: "ses_1" }),
    ).rejects.toThrow("network down");
  });

  test("rejects fetchDiff when the SDK request promise rejects", async () => {
    const { client } = recordingClient(() => Promise.reject(new Error("network down")));

    await expect(
      createOpenCodeSessionFacade(client).fetchDiff({ sessionID: "ses_1", messageID: "msg_u1" }),
    ).rejects.toThrow("network down");
  });

  test("rejects listMessages when the SDK resolves with an error and no data", async () => {
    const { client } = recordingClient(() => Promise.resolve(errorResponse(404)));

    await expect(
      createOpenCodeSessionFacade(client).listMessages({ sessionID: "ses_1" }),
    ).rejects.toBeInstanceOf(Error);
  });

  test("rejects fetchDiff when the SDK resolves with an error and no data", async () => {
    const { client } = recordingClient(() => Promise.resolve(errorResponse(404)));

    await expect(
      createOpenCodeSessionFacade(client).fetchDiff({ sessionID: "ses_1", messageID: "msg_u1" }),
    ).rejects.toBeInstanceOf(Error);
  });
});
