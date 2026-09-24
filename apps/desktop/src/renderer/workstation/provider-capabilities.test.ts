import { describe, expect, it } from "vitest";
import {
  menuFor,
  menusFor,
  type ObservedProvider,
} from "./provider-capabilities.js";

describe("provider-capabilities menuFor", () => {
  it("marks asks-before-acting as observed when canApproveTools is true", () => {
    const provider: ObservedProvider = {
      id: "claude",
      label: "Claude",
      family: "claude",
      detected: true,
      detail: "Ready",
      models: [{ id: "claude-3-5-sonnet", label: "Claude 3.5 Sonnet" }],
      canApproveTools: true,
    };

    const menu = menuFor(provider);
    const cap = menu.capabilities.find((c) => c.id === "asks-before-acting");

    expect(cap).toBeDefined();
    expect(cap!.observed).toBe(true);
    expect(cap!.because).toContain("confirmed it can pause and ask");
  });

  it("marks asks-before-acting as unobserved when canApproveTools is false", () => {
    const provider: ObservedProvider = {
      id: "gemini",
      label: "Gemini",
      family: "gemini",
      detected: true,
      detail: "Ready",
      models: [{ id: "gemini-1-5-pro", label: "Gemini 1.5 Pro" }],
      canApproveTools: false,
    };

    const menu = menuFor(provider);
    const cap = menu.capabilities.find((c) => c.id === "asks-before-acting");

    expect(cap).toBeDefined();
    expect(cap!.observed).toBe(false);
    expect(cap!.because).toContain("cannot pause to ask");
  });

  it("marks stays-on-this-mac as observed only for local family", () => {
    const localProvider: ObservedProvider = {
      id: "llama",
      label: "Local Llama",
      family: "local",
      detected: true,
      detail: "Running locally",
      models: [{ id: "llama-3", label: "Llama 3" }],
      canApproveTools: false,
    };
    const cloudProvider: ObservedProvider = {
      id: "codex",
      label: "Codex",
      family: "codex",
      detected: true,
      detail: "Signed in",
      models: [{ id: "o3-mini", label: "o3-mini" }],
      canApproveTools: true,
    };

    const localMenu = menuFor(localProvider);
    const cloudMenu = menuFor(cloudProvider);

    const localCap = localMenu.capabilities.find((c) => c.id === "stays-on-this-mac");
    const cloudCap = cloudMenu.capabilities.find((c) => c.id === "stays-on-this-mac");

    expect(localCap!.observed).toBe(true);
    expect(localCap!.because).toContain("without sending data outside");
    expect(cloudCap!.observed).toBe(false);
    expect(cloudCap!.because).toContain("provider's remote servers");
  });

  it("never infers unobserved capabilities from model id text", () => {
    const provider: ObservedProvider = {
      id: "codex",
      label: "Codex",
      family: "codex",
      detected: true,
      detail: "Connected",
      models: [
        {
          id: "gpt-5-long-context-vision-coder-reasoning",
          label: "GPT-5 with Vision and Long Context",
        },
      ],
      canApproveTools: true,
    };

    const menu = menuFor(provider);
    const unobservedIds = [
      "long-context",
      "reads-files",
      "reasons-in-steps",
      "reads-images",
      "writes-code",
      "picks-effort",
    ] as const;

    for (const id of unobservedIds) {
      const cap = menu.capabilities.find((c) => c.id === id);
      expect(cap).toBeDefined();
      expect(cap!.observed).toBe(false);
      expect(cap!.because).toContain("not been checked");
    }
  });

  it("builds a full menu for an undetected provider with usable false and reason from detail", () => {
    const provider: ObservedProvider = {
      id: "claude",
      label: "Claude",
      family: "claude",
      detected: false,
      detail: "Claude CLI was not found in PATH",
      models: [],
      canApproveTools: false,
    };

    const menu = menuFor(provider);

    expect(menu.usable).toBe(false);
    expect(menu.unusableBecause).toBe("Claude CLI was not found in PATH");
    expect(menu.capabilities.length).toBe(8);
    expect(menu.models.length).toBeGreaterThan(0);
    expect(menu.summary).toContain("Claude CLI was not found in PATH");
  });

  it("offers subscription default when a detected provider has no models", () => {
    const provider: ObservedProvider = {
      id: "gemini",
      label: "Gemini",
      family: "gemini",
      detected: true,
      detail: "Signed in",
      models: [],
      canApproveTools: false,
    };

    const menu = menuFor(provider);

    expect(menu.usable).toBe(true);
    expect(menu.unusableBecause).toBeNull();
    expect(menu.models).toEqual([
      {
        id: "default",
        label: "Subscription default",
        note: "Only the subscription's own default is available",
      },
    ]);
    expect(menu.summary).toContain("subscription's default model");
  });

  it("provides effort levels only for codex family", () => {
    const codexProvider: ObservedProvider = {
      id: "codex",
      label: "Codex",
      family: "codex",
      detected: true,
      detail: "Connected",
      models: [{ id: "o3-mini", label: "o3-mini" }],
      canApproveTools: true,
    };
    const claudeProvider: ObservedProvider = {
      id: "claude",
      label: "Claude",
      family: "claude",
      detected: true,
      detail: "Connected",
      models: [{ id: "claude-3-5-sonnet", label: "Claude 3.5 Sonnet" }],
      canApproveTools: true,
    };

    const codexMenu = menuFor(codexProvider);
    const claudeMenu = menuFor(claudeProvider);

    expect(codexMenu.effortLevels.map((e) => e.id)).toEqual(["low", "medium", "high"]);
    expect(claudeMenu.effortLevels).toEqual([]);
  });

  it("deduplicates models by id preserving the first occurrence", () => {
    const provider: ObservedProvider = {
      id: "codex",
      label: "Codex",
      family: "codex",
      detected: true,
      detail: "Connected",
      models: [
        { id: "o3-mini", label: "o3-mini (fast)" },
        { id: "o3-mini", label: "o3-mini (duplicate)" },
        { id: "gpt-4o", label: "GPT-4o" },
      ],
      canApproveTools: true,
    };

    const menu = menuFor(provider);

    expect(menu.models.length).toBe(2);
    expect(menu.models[0]).toEqual({
      id: "o3-mini",
      label: "o3-mini (fast)",
      note: "fast",
    });
    expect(menu.models[1]).toEqual({
      id: "gpt-4o",
      label: "GPT-4o",
      note: "",
    });
  });

  it("handles long provider labels gracefully", () => {
    const longLabel = "Codex Enterprise Custom Deployment ".repeat(6).trim();
    const provider: ObservedProvider = {
      id: "codex",
      label: longLabel,
      family: "codex",
      detected: true,
      detail: "Connected",
      models: [{ id: "o3-mini", label: "o3-mini" }],
      canApproveTools: true,
    };

    const menu = menuFor(provider);

    expect(menu.label).toBe(longLabel);
    expect(menu.usable).toBe(true);
    expect(menu.summary.endsWith(".")).toBe(true);
  });

  it("transforms a list of providers with menusFor", () => {
    const providers: readonly ObservedProvider[] = [
      {
        id: "codex",
        label: "Codex",
        family: "codex",
        detected: true,
        detail: "Ready",
        models: [{ id: "o3-mini", label: "o3-mini" }],
        canApproveTools: true,
      },
      {
        id: "local",
        label: "Local",
        family: "local",
        detected: false,
        detail: "Server not running",
        models: [],
        canApproveTools: false,
      },
    ];

    const menus = menusFor(providers);

    expect(menus.length).toBe(2);
    expect(menus[0]!.id).toBe("codex");
    expect(menus[0]!.usable).toBe(true);
    expect(menus[1]!.id).toBe("local");
    expect(menus[1]!.usable).toBe(false);
  });
});
