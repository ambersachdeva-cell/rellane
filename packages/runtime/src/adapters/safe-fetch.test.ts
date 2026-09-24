import { describe, expect, it } from "vitest";
import { assertAllowedLoopbackUrl } from "./safe-fetch.js";

describe("assertAllowedLoopbackUrl", () => {
  it.each([
    "http://127.0.0.1:11434/api/tags",
    "http://localhost:1234/v1/models",
    "http://[::1]:11434/api/version"
  ])("allows a fixed local runtime endpoint: %s", (value) => {
    expect(assertAllowedLoopbackUrl(value).toString()).toBe(value);
  });

  it.each([
    "https://127.0.0.1:11434/api/tags",
    "http://127.0.0.1:9999/api/tags",
    "http://localhost.example.com:11434/api/tags",
    "http://user:pass@127.0.0.1:11434/api/tags",
    "http://192.168.1.3:1234/v1/models"
  ])("rejects a non-contract endpoint: %s", (value) => {
    expect(() => assertAllowedLoopbackUrl(value)).toThrow(/loopback/i);
  });
});
