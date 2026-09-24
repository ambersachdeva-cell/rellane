import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, rm, chmod, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverWorkstationProviders,
  findClaudeExecutable,
  resolveGeminiProfileHome
} from "./providers.js";

describe("discoverWorkstationProviders", () => {
  it("returns launches for all five workstation providers with correct IDs and families", async () => {
    const launches = await discoverWorkstationProviders({
      codexPath: "/Applications/ChatGPT.app/Contents/Resources/codex",
      claudePath: "/mock/path/claude",
      agyPath: "/Users/example/.local/bin/agy",
      setupDir: "/Users/example/agy-setup"
    });

    expect(launches.length).toBe(5);

    const [codex, claude, gemini1, gemini2, gemini3] = launches;
    expect(codex?.provider.id).toBe("codex");
    expect(codex?.provider.family).toBe("codex");
    expect(codex?.provider.canApproveTools).toBe(true);
    expect(codex?.provider.canResume).toBe(true);

    expect(claude?.provider.id).toBe("claude");
    expect(claude?.provider.family).toBe("claude");
    // False until there is a verified way to ask before a tool runs. The
    // headless session has no tools, so it has nothing to approve.
    expect(claude?.provider.canApproveTools).toBe(true);
    expect(claude?.provider.detail).toMatch(/Rellane does not check it/u);
    expect(claude?.provider.canResume).toBe(true);
    expect(claude?.provider.models.map(value => value.id)).toEqual(["opus", "sonnet"]);

    expect(gemini1?.provider.id).toBe("gemini1");
    expect(gemini1?.provider.family).toBe("gemini");
    expect(gemini1?.profileHome).toBe("/Users/example/agy-setup/config1");
    expect(gemini1?.provider.canApproveTools).toBe(false);
    expect(gemini1?.provider.canResume).toBe(true);
    expect(gemini1?.provider.models[0]?.id).toBe("gemini-3.8-flash-high");

    expect(gemini2?.provider.id).toBe("gemini2");
    expect(gemini2?.profileHome).toBe("/Users/example/agy-setup/config2");
    expect(gemini2?.provider.canApproveTools).toBe(false);

    expect(gemini3?.provider.id).toBe("gemini3");
    expect(gemini3?.profileHome).toBe("/Users/example/agy-setup/config3");
    expect(gemini3?.provider.canApproveTools).toBe(false);
  });

  it("marks unavailable when executables are null without throwing", async () => {
    const launches = await discoverWorkstationProviders({
      codexPath: null,
      claudePath: null,
      agyPath: null
    });

    for (const launch of launches) {
      expect(launch.provider.state).toBe("unavailable");
      expect(launch.executable).toBeNull();
      expect(launch.provider.detail.length).toBeGreaterThan(0);
    }
  });

  it("finds newest Claude executable among installed extension versions", async () => {
    const testHome = await mkdtemp(join(tmpdir(), "cadrane-claude-test-"));
    try {
      const extRoot = join(testHome, ".vscode", "extensions");
      const v1 = join(extRoot, "anthropic.claude-code-2.1.263-darwin-arm64", "resources", "native-binary");
      const v2 = join(extRoot, "anthropic.claude-code-2.1.264-darwin-arm64", "resources", "native-binary");

      await mkdir(v1, { recursive: true });
      await mkdir(v2, { recursive: true });

      const binary1 = join(v1, "claude");
      const binary2 = join(v2, "claude");
      await writeFile(binary1, "#!/bin/sh\nexit 0\n");
      await writeFile(binary2, "#!/bin/sh\nexit 0\n");
      await chmod(binary1, 0o755);
      await chmod(binary2, 0o755);

      const detected = await findClaudeExecutable(testHome);
      expect(detected).toBe(binary2);
    } finally {
      await rm(testHome, { recursive: true, force: true });
    }
  });

  it("says a profile folder is missing without claiming anything about sign-in", async () => {
    const setupDir = await mkdtemp(join(tmpdir(), "cadrane-agy-setup-"));
    try {
      await mkdir(join(setupDir, "config1"), { recursive: true });

      const launches = await discoverWorkstationProviders({
        codexPath: null,
        claudePath: null,
        agyPath: "/mock/bin/agy",
        setupDir
      });

      const present = launches.find((launch) => launch.provider.id === "gemini1");
      const absent = launches.find((launch) => launch.provider.id === "gemini2");

      expect(present?.provider.detail).toMatch(/Rellane does not check it/u);
      expect(absent?.provider.detail).toContain("config2");
      expect(absent?.provider.detail).toContain("not been used yet");
      // Detected is about a file being there, never about an account working.
      expect(present?.provider.state).toBe("detected");
      expect(absent?.provider.state).toBe("detected");
    } finally {
      await rm(setupDir, { recursive: true, force: true });
    }
  });

  it("correctly resolves gemini profile homes for all three profiles", () => {
    expect(resolveGeminiProfileHome("config1", "/custom/agy-setup")).toBe("/custom/agy-setup/config1");
    expect(resolveGeminiProfileHome("config2", "/custom/agy-setup")).toBe("/custom/agy-setup/config2");
    expect(resolveGeminiProfileHome("config3", "/custom/agy-setup")).toBe("/custom/agy-setup/config3");
  });
});
