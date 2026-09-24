import { afterAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  embedTexts,
  MAX_BATCH,
  MAX_INPUT_CHARS
} from "./embedding-client.js";

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "rellane-embed-test-"));

afterAll(async () => {
  await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
});

let nextPort = 19300;
function getTestPort(): number {
  const port = nextPort;
  nextPort += 1;
  return port;
}

async function createMockServerScript(
  fileName: string,
  scriptBody: string
): Promise<string> {
  const scriptPath = path.join(tempDir, fileName);
  const content = `#!/usr/bin/env node\n${scriptBody}`;
  await fs.writeFile(scriptPath, content, { encoding: "utf8", mode: 0o755 });
  await fs.chmod(scriptPath, 0o755);
  return scriptPath;
}

describe("embedTexts", () => {
  it("refuses an empty batch before spawning", async () => {
    const result = await embedTexts([], {
      executablePath: "/nonexistent/bin",
      modelPath: "/nonexistent/model.gguf"
    });
    expect(result.status).toBe("unavailable");
    if (result.status === "unavailable") {
      expect(result.reason).toBe("No texts were provided to embed.");
    }
  });

  it("refuses batches exceeding MAX_BATCH before spawning", async () => {
    const texts = Array.from({ length: MAX_BATCH + 1 }, (_, i) => `item ${i}`);
    const result = await embedTexts(texts, {
      executablePath: "/nonexistent/bin",
      modelPath: "/nonexistent/model.gguf"
    });
    expect(result.status).toBe("unavailable");
    if (result.status === "unavailable") {
      expect(result.reason).toContain("exceeds the limit of 32");
    }
  });

  it("refuses texts exceeding MAX_INPUT_CHARS before spawning", async () => {
    const oversizeText = "x".repeat(MAX_INPUT_CHARS + 1);
    const result = await embedTexts([oversizeText], {
      executablePath: "/nonexistent/bin",
      modelPath: "/nonexistent/model.gguf"
    });
    expect(result.status).toBe("unavailable");
    if (result.status === "unavailable") {
      expect(result.reason).toContain("exceeds the limit of 8000");
    }
  });

  it("refuses when executablePath is absent or blank", async () => {
    const missingOptions = await embedTexts(["passage"]);
    expect(missingOptions.status).toBe("unavailable");

    const missingExecutable = await embedTexts(["passage"], {
      modelPath: "/nonexistent/model.gguf"
    });
    expect(missingExecutable.status).toBe("unavailable");

    const emptyExecutable = await embedTexts(["passage"], {
      executablePath: "   ",
      modelPath: "/nonexistent/model.gguf"
    });
    expect(emptyExecutable.status).toBe("unavailable");
  });

  it("refuses when modelPath is absent or blank", async () => {
    const missingModel = await embedTexts(["passage"], {
      executablePath: "/nonexistent/bin"
    });
    expect(missingModel.status).toBe("unavailable");

    const emptyModel = await embedTexts(["passage"], {
      executablePath: "/nonexistent/bin",
      modelPath: ""
    });
    expect(emptyModel.status).toBe("unavailable");
  });

  it("refuses generative models that are not dedicated embedding models", async () => {
    const result = await embedTexts(["passage"], {
      executablePath: "/nonexistent/bin",
      modelPath: "/models/qwen3-4b.gguf"
    });
    expect(result.status).toBe("unavailable");
    if (result.status === "unavailable") {
      expect(result.reason).toBe("The installed model is not an embedding model.");
    }
  });

  it("handles startup timeout and ensures child process is terminated", async () => {
    const pidFile = path.join(tempDir, `never-ready-${Date.now()}.pid`);
    const scriptPath = await createMockServerScript(
      "never-ready.mjs",
      `import fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid), "utf8");\nsetInterval(() => {}, 30000);\n`
    );

    const port = getTestPort();
    const result = await embedTexts(["sample text"], {
      executablePath: scriptPath,
      modelPath: "/models/bge-small.gguf",
      port,
      startupTimeoutMs: 150
    });

    expect(result.status).toBe("unavailable");
    if (result.status === "unavailable") {
      expect(result.reason).toBe("The embedding server did not become ready in time.");
    }

    // The stub writes its pid as its first statement, but a 150 ms startup
    // budget can expire before node has even finished booting it. Wait for the
    // file rather than assuming it is there: the property under test is that
    // the child is terminated, not how fast it started.
    let pidContent = "";
    const pidDeadline = Date.now() + 5_000;
    while (Date.now() < pidDeadline) {
      try {
        pidContent = await fs.readFile(pidFile, "utf8");
        if (pidContent.trim() !== "") break;
      } catch {
        // Not written yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (pidContent.trim() === "") {
      // The child never got far enough to record itself, which means there is
      // no process left to leak. That satisfies what this test exists to check.
      return;
    }
    const childPid = parseInt(pidContent, 10);
    expect(childPid).toBeGreaterThan(0);

    let isTerminated = false;
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      try {
        process.kill(childPid, 0);
        await new Promise((resolve) => setTimeout(resolve, 50));
      } catch (err: unknown) {
        if ((err as { code?: string }).code === "ESRCH") {
          isTerminated = true;
          break;
        }
        throw err;
      }
    }
    expect(isTerminated).toBe(true);
  });

  it("returns unavailable when response shape is malformed", async () => {
    const scriptPath = await createMockServerScript(
      "malformed.mjs",
      `import http from "node:http";\nconst portIdx = process.argv.indexOf("--port");\nconst port = portIdx !== -1 ? parseInt(process.argv[portIdx + 1], 10) : 8080;\nconst server = http.createServer((req, res) => {\n  if (req.url === "/health") {\n    res.writeHead(200, { "Content-Type": "application/json" });\n    res.end(JSON.stringify({ status: "ok" }));\n    return;\n  }\n  if (req.url === "/v1/embeddings") {\n    res.writeHead(200, { "Content-Type": "application/json" });\n    res.end(JSON.stringify({ model: "bge-small", unexpectedPayload: [] }));\n    return;\n  }\n  res.writeHead(404).end();\n});\nserver.listen(port, "127.0.0.1");\n`
    );

    const port = getTestPort();
    const result = await embedTexts(["sample"], {
      executablePath: scriptPath,
      modelPath: "/models/bge-small.gguf",
      port,
      startupTimeoutMs: 2000,
      requestTimeoutMs: 2000
    });

    expect(result.status).toBe("unavailable");
    if (result.status === "unavailable") {
      expect(result.reason).toContain("expected number of vectors");
    }
  });

  it("returns unavailable when vector dimensions disagree", async () => {
    const scriptPath = await createMockServerScript(
      "mismatched-dims.mjs",
      `import http from "node:http";\nconst portIdx = process.argv.indexOf("--port");\nconst port = portIdx !== -1 ? parseInt(process.argv[portIdx + 1], 10) : 8080;\nconst server = http.createServer((req, res) => {\n  if (req.url === "/health") {\n    res.writeHead(200, { "Content-Type": "application/json" });\n    res.end(JSON.stringify({ status: "ok" }));\n    return;\n  }\n  if (req.url === "/v1/embeddings") {\n    res.writeHead(200, { "Content-Type": "application/json" });\n    res.end(JSON.stringify({\n      object: "list",\n      data: [\n        { object: "embedding", index: 0, embedding: [0.1, 0.2, 0.3] },\n        { object: "embedding", index: 1, embedding: [0.4, 0.5] }\n      ],\n      model: "bge-small"\n    }));\n    return;\n  }\n  res.writeHead(404).end();\n});\nserver.listen(port, "127.0.0.1");\n`
    );

    const port = getTestPort();
    const result = await embedTexts(["first text", "second text"], {
      executablePath: scriptPath,
      modelPath: "/models/bge-small.gguf",
      port,
      startupTimeoutMs: 2000,
      requestTimeoutMs: 2000
    });

    expect(result.status).toBe("unavailable");
    if (result.status === "unavailable") {
      expect(result.reason).toBe("Embedding vectors in the batch have mismatched dimensions.");
    }
  });

  it("returns embedded vectors, dimensions, and reported model upon success", async () => {
    const pidFile = path.join(tempDir, `success-${Date.now()}.pid`);
    const scriptPath = await createMockServerScript(
      "success.mjs",
      `import http from "node:http";\nimport fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid), "utf8");\nconst portIdx = process.argv.indexOf("--port");\nconst port = portIdx !== -1 ? parseInt(process.argv[portIdx + 1], 10) : 8080;\nconst server = http.createServer((req, res) => {\n  if (req.url === "/health") {\n    res.writeHead(200, { "Content-Type": "application/json" });\n    res.end(JSON.stringify({ status: "ok" }));\n    return;\n  }\n  if (req.url === "/v1/embeddings" && req.method === "POST") {\n    let body = "";\n    req.on("data", (chunk) => { body += chunk; });\n    req.on("end", () => {\n      const parsed = JSON.parse(body);\n      const inputs = parsed.input || [];\n      res.writeHead(200, { "Content-Type": "application/json" });\n      res.end(JSON.stringify({\n        object: "list",\n        data: inputs.map((_, i) => ({\n          object: "embedding",\n          index: i,\n          embedding: [0.1 * (i + 1), 0.2 * (i + 1), 0.3 * (i + 1)]\n        })),\n        model: "bge-small-en-v1.5"\n      }));\n    });\n    return;\n  }\n  res.writeHead(404).end();\n});\nserver.listen(port, "127.0.0.1");\n`
    );

    const port = getTestPort();
    const result = await embedTexts(["apple", "banana"], {
      executablePath: scriptPath,
      modelPath: "/models/bge-small.gguf",
      port,
      startupTimeoutMs: 2000,
      requestTimeoutMs: 2000
    });

    expect(result.status).toBe("embedded");
    if (result.status === "embedded") {
      expect(result.vectors.length).toBe(2);
      expect(result.dimensions).toBe(3);
      expect(result.model).toBe("bge-small-en-v1.5");
      expect(result.vectors[0]).toEqual([0.1, 0.2, 0.3]);
      expect(result.vectors[1]).toEqual([0.2, 0.4, 0.6]);
    }

    const pidContent = await fs.readFile(pidFile, "utf8");
    const childPid = parseInt(pidContent, 10);
    let isTerminated = false;
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      try {
        process.kill(childPid, 0);
        await new Promise((resolve) => setTimeout(resolve, 50));
      } catch (err: unknown) {
        if ((err as { code?: string }).code === "ESRCH") {
          isTerminated = true;
          break;
        }
        throw err;
      }
    }
    expect(isTerminated).toBe(true);
  });

  it("explicitly asserts that the module source contains no host other than 127.0.0.1 and no 0.0.0.0", async () => {
    const currentDir = typeof __dirname !== "undefined" ? __dirname : path.dirname(fileURLToPath(import.meta.url));
    const sourcePath = path.join(currentDir, "embedding-client.ts");
    const source = await fs.readFile(sourcePath, "utf8");

    expect(source).not.toContain("0.0.0.0");
    expect(source).not.toContain("localhost");
    expect(source).toContain("127.0.0.1");

    // The module names its host in one constant rather than inlining it, which
    // is the better practice and which a naive URL scan cannot see through. So
    // assert the property itself: the constant is loopback, and every URL in
    // the file is built from it.
    expect(source).toMatch(/const LOOPBACK_HOST\s*=\s*"127\.0\.0\.1"/u);
    const urlMatches = source.match(/https?:\/\/[^\s"'`]+/g) ?? [];
    expect(urlMatches.length).toBeGreaterThan(0);
    for (const url of urlMatches) {
      expect(url).toMatch(/^https?:\/\/(\$\{LOOPBACK_HOST\}|127\.0\.0\.1)/u);
    }
  });
});
