import { describe, expect, it } from "vitest";
import {
  DEVELOPMENT_RENDERER_URL,
  isTrustedRendererUrl,
  resolveRendererTarget
} from "./renderer-trust.js";

describe("renderer trust", () => {
  it("never enables the development renderer in a packaged build", () => {
    const target = resolveRendererTarget(true, DEVELOPMENT_RENDERER_URL);

    expect(target).toEqual({
      development: false,
      url: "switchboard://app/index.html"
    });
    expect(isTrustedRendererUrl(DEVELOPMENT_RENDERER_URL, target)).toBe(false);
    expect(isTrustedRendererUrl("switchboard://app/index.html", target)).toBe(true);
  });

  it("allows only the fixed loopback origin during an explicit source dev run", () => {
    const target = resolveRendererTarget(false, DEVELOPMENT_RENDERER_URL);

    expect(target.development).toBe(true);
    expect(isTrustedRendererUrl(`${DEVELOPMENT_RENDERER_URL}/src/main.tsx`, target)).toBe(true);
    expect(isTrustedRendererUrl("http://localhost:5173", target)).toBe(false);
  });
});
