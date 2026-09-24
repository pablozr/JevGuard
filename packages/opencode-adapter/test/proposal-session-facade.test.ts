import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/client";
import { describe, expect, test } from "vitest";
import { createOpenCodeProposalSessionFacade } from "../src/index";

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

const PROMPT = {
  sessionID: "ses_child",
  agent: "jevguard-proposer",
  model: { providerID: "opencode", modelID: "gpt-5.6-luna" },
  system: "system contract",
  tools: { "*": false },
  text: "proposal body",
} as const;

describe("createOpenCodeProposalSessionFacade", () => {
  test("creates a child session under the parent and returns its id", async () => {
    const { client, requests } = recordingClient(() =>
      Promise.resolve(jsonResponse({ id: "ses_child", parentID: "ses_1" })),
    );

    const sessionID = await createOpenCodeProposalSessionFacade(client).createChildSession({
      parentID: "ses_1",
      title: "JevGuard remediation proposal",
    });

    expect(sessionID).toBe("ses_child");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.path).toBe("/session");
    expect(JSON.parse(requests[0]?.body ?? "{}")).toEqual({
      parentID: "ses_1",
      title: "JevGuard remediation proposal",
    });
  });

  test("prompts the child session with the explicit agent, model, system, and disabled tools", async () => {
    const { client, requests } = recordingClient(() =>
      Promise.resolve(jsonResponse({ info: { id: "msg_1" }, parts: [] })),
    );

    await createOpenCodeProposalSessionFacade(client).prompt(PROMPT);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.path).toBe("/session/ses_child/message");
    expect(JSON.parse(requests[0]?.body ?? "{}")).toEqual({
      agent: "jevguard-proposer",
      model: { providerID: "opencode", modelID: "gpt-5.6-luna" },
      system: "system contract",
      tools: { "*": false },
      parts: [{ type: "text", text: "proposal body" }],
    });
  });

  test("rejects createChildSession when the SDK resolves with an error and no data", async () => {
    const { client } = recordingClient(() => Promise.resolve(errorResponse(400)));

    await expect(
      createOpenCodeProposalSessionFacade(client).createChildSession({
        parentID: "ses_1",
        title: "proposal",
      }),
    ).rejects.toBeInstanceOf(Error);
  });

  test("rejects prompt when the SDK resolves with an error and no data", async () => {
    const { client } = recordingClient(() => Promise.resolve(errorResponse(404)));

    await expect(createOpenCodeProposalSessionFacade(client).prompt(PROMPT)).rejects.toBeInstanceOf(
      Error,
    );
  });
});
