import { describe, expect, it } from "vitest";
import { RuntimeBoundaryError } from "../errors.js";
import {
  requestModelArtifact,
  type ModelDownloadHttpRequest,
  type ModelDownloadHttpResponse,
  type ModelDownloadTransport
} from "./model-download-network.js";

describe("model download network", () => {
  it("disposes every inspected redirect response", async () => {
    let disposed = 0;
    const transport = new QueueTransport([
      redirectResponse(
        "https://huggingface.co/owner/model/resolve/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/model.gguf",
        "https://us.aws.cdn.hf.co/signed/model.gguf",
        () => {
          disposed += 1;
        }
      ),
      okResponse("https://us.aws.cdn.hf.co/signed/model.gguf")
    ]);
    const response = await requestModelArtifact(
      transport,
      "https://huggingface.co/owner/model/resolve/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/model.gguf",
      {},
      new AbortController().signal,
      { allowedRedirectOrigins: ["https://us.aws.cdn.hf.co"] }
    );
    expect(response.status).toBe(200);
    expect(disposed).toBe(1);
  });

  it("disposes a rejected redirect without exposing its signed URL", async () => {
    let disposed = 0;
    const source =
      "https://huggingface.co/owner/model/resolve/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/model.gguf";
    const transport = new QueueTransport([
      redirectResponse(source, "https://example.com/private?token=secret", () => {
        disposed += 1;
      })
    ]);
    try {
      await requestModelArtifact(
        transport,
        source,
        {},
        new AbortController().signal
      );
      throw new Error("Expected the redirect to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(RuntimeBoundaryError);
      expect((error as RuntimeBoundaryError).detail).toMatchObject({
        code: "SECURITY_BOUNDARY"
      });
      expect((error as RuntimeBoundaryError).detail.message).not.toContain("token");
    }
    expect(disposed).toBe(1);
  });

  it("disposes a response when the transport followed an uninspected redirect", async () => {
    let disposed = 0;
    const source =
      "https://huggingface.co/owner/model/resolve/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/model.gguf";
    const transport = new QueueTransport([
      {
        ...okResponse("https://uninspected.example/model.gguf"),
        dispose: async () => {
          disposed += 1;
        }
      }
    ]);

    await expect(
      requestModelArtifact(
        transport,
        source,
        {},
        new AbortController().signal
      )
    ).rejects.toMatchObject({
      detail: { code: "SECURITY_BOUNDARY" }
    });
    expect(disposed).toBe(1);
  });
});

class QueueTransport implements ModelDownloadTransport {
  constructor(private readonly responses: ModelDownloadHttpResponse[]) {}

  async request(_request: ModelDownloadHttpRequest): Promise<ModelDownloadHttpResponse> {
    const response = this.responses.shift();
    if (response === undefined) {
      throw new Error("No response remains.");
    }
    return response;
  }
}

function redirectResponse(
  url: string,
  location: string,
  onDispose: () => void
): ModelDownloadHttpResponse {
  return {
    status: 302,
    url,
    headers: {
      get: (name) => name.toLowerCase() === "location" ? location : null
    },
    body: (async function* () {
      yield Buffer.from("redirect");
    })(),
    dispose: async () => {
      onDispose();
    }
  };
}

function okResponse(url: string): ModelDownloadHttpResponse {
  return {
    status: 200,
    url,
    headers: { get: () => null },
    body: (async function* () {
      yield Buffer.from("ok");
    })()
  };
}
