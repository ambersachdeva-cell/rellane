import { describe, expect, it } from "vitest";
import {
  DAEMON_PROTOCOL_VERSION,
  DESKTOP_BRIDGE_VERSION,
  DaemonReadyEventSchema,
  DaemonRequestSchema,
  RuntimeDescriptorSchema
} from "./local-intelligence.js";
import { DaemonShutdownRequestSchema } from "./daemon-control.js";

const requestId = "11111111-1111-4111-8111-111111111111";
const operationId = "22222222-2222-4222-8222-222222222222";
const digest = "a".repeat(64);
const acceptance = {
  modelId: "qwen3-4b-q4-k-m",
  artifactSha256: digest,
  catalogGeneration: 1,
  licenseNoticeVersion: "Apache-2.0-2004-static-beta-1",
  licenseNoticeSha256: "b".repeat(64),
  accepted: true
} as const;

describe("daemon protocol v5 model install requests", () => {
  it("moves the daemon protocol and desktop bridge together", () => {
    expect(DAEMON_PROTOCOL_VERSION).toBe(5);
    expect(DESKTOP_BRIDGE_VERSION).toBe(4);
  });

  it.each([
    ["model.install.snapshot", {}],
    ["model.license.review", { modelId: "qwen3-4b-q4-k-m" }],
    ["model.license.acknowledge", acceptance],
    ["model.install.start", { modelId: "qwen3-4b-q4-k-m" }],
    ["model.install.cancel", { operationId }]
  ] as const)("accepts the exact %s renderer payload", (type, payload) => {
    expect(DaemonRequestSchema.parse({
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      requestId,
      type,
      payload
    })).toEqual({
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      requestId,
      type,
      payload
    });
  });

  it.each([
    ["model.install.snapshot", { dataDir: "/tmp/private" }],
    ["model.license.review", {
      modelId: "qwen3-4b-q4-k-m",
      downloadUrl: "https://example.invalid/model.gguf"
    }],
    ["model.license.acknowledge", {
      ...acceptance,
      acceptedAt: "2026-07-30T00:00:00.000Z"
    }],
    ["model.install.start", {
      modelId: "qwen3-4b-q4-k-m",
      destinationPath: "/tmp/model.gguf"
    }],
    ["model.install.cancel", {
      operationId,
      modelId: "qwen3-4b-q4-k-m"
    }]
  ] as const)("rejects extra privileged fields for %s", (type, payload) => {
    expect(DaemonRequestSchema.safeParse({
      protocolVersion: 3,
      requestId,
      type,
      payload
    }).success).toBe(false);
    expect(DaemonReadyEventSchema.safeParse({
      protocolVersion: 1,
      type: "daemon.ready",
      pid: 123
    }).success).toBe(false);
  });

  it("fails closed for stale protocol envelopes", () => {
    expect(DaemonRequestSchema.safeParse({
      protocolVersion: 1,
      requestId,
      type: "model.install.snapshot",
      payload: {}
    }).success).toBe(false);
  });

  it("keeps daemon shutdown outside the renderer work-request contract", () => {
    const shutdown = {
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      requestId,
      type: "daemon.shutdown",
      payload: {}
    };
    expect(DaemonShutdownRequestSchema.safeParse(shutdown).success).toBe(true);
    expect(DaemonRequestSchema.safeParse(shutdown).success).toBe(false);
  });
});

describe("renderer-safe runtime descriptors", () => {
  const shared = {
    id: "local-runtime",
    name: "Local runtime",
    state: "available",
    version: null,
    models: [],
    detail: "The local runtime is available.",
    checkedAt: "2026-07-31T00:00:00.000Z"
  } as const;

  it.each([
    ["ollama", "http://127.0.0.1:11434"],
    ["lm-studio", "http://127.0.0.1:1234"]
  ] as const)("requires a validated loopback URL for %s", (kind, baseUrl) => {
    expect(RuntimeDescriptorSchema.parse({
      ...shared,
      kind,
      baseUrl
    })).toMatchObject({ kind, baseUrl });
    expect(RuntimeDescriptorSchema.safeParse({
      ...shared,
      kind,
      baseUrl: null
    }).success).toBe(false);
    expect(RuntimeDescriptorSchema.safeParse({
      ...shared,
      kind,
      baseUrl: "https://example.com"
    }).success).toBe(false);
    expect(RuntimeDescriptorSchema.safeParse({
      ...shared,
      kind,
      baseUrl: baseUrl.replace("http:", "https:")
    }).success).toBe(false);
    expect(RuntimeDescriptorSchema.safeParse({
      ...shared,
      kind,
      baseUrl: baseUrl.replace(/:[0-9]+$/, ":9999")
    }).success).toBe(false);
  });

  it("allows no URL or privileged launch detail for the managed runtime", () => {
    expect(RuntimeDescriptorSchema.parse({
      ...shared,
      kind: "managed-llama",
      baseUrl: null
    })).toMatchObject({
      kind: "managed-llama",
      baseUrl: null
    });
    expect(RuntimeDescriptorSchema.safeParse({
      ...shared,
      kind: "managed-llama",
      baseUrl: "http://127.0.0.1:49152"
    }).success).toBe(false);
  });

  it.each([
    "port",
    "apiKey",
    "executablePath",
    "modelPath",
    "userDataPath",
    "activationReceipt"
  ])("rejects privileged managed-runtime field %s", (field) => {
    expect(RuntimeDescriptorSchema.safeParse({
      ...shared,
      kind: "managed-llama",
      baseUrl: null,
      [field]: "private"
    }).success).toBe(false);
  });
});
