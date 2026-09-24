import { describe, expect, it } from "vitest";
import {
  chooseBackend,
  describeSpeed,
  mlxIsPossible,
  tokensPerSecond,
  type BackendCapability,
  type Benchmark
} from "./backend.js";
import {
  explainUnavailable,
  route,
  worksWithoutAnyEngine,
  type TierAvailability
} from "./ladder.js";

const MLX_YES: BackendCapability = { id: "mlx", available: true, detail: "mlx-lm 0.29.1" };
const MLX_NO: BackendCapability = { id: "mlx", available: false, detail: "mlx-lm is not installed." };
const LLAMA: BackendCapability = { id: "llama-cpp", available: true, detail: "b10182" };

describe("where MLX is even possible", () => {
  it("is Apple Silicon only", () => {
    expect(mlxIsPossible({ platform: "darwin", architecture: "arm64", acceleration: "metal" })).toBe(true);
    expect(mlxIsPossible({ platform: "darwin", architecture: "x64", acceleration: "metal" })).toBe(false);
    expect(mlxIsPossible({ platform: "win32", architecture: "x64", acceleration: "cuda" })).toBe(false);
  });
});

describe("choosing a backend", () => {
  it("prefers MLX for a model small enough to benefit", () => {
    const choice = chooseBackend({ parametersBillions: 9, backends: [MLX_YES, LLAMA] });
    expect(choice.backend).toBe("mlx");
  });

  it("uses the bundled engine for a large model where they converge", () => {
    const choice = chooseBackend({ parametersBillions: 30, backends: [MLX_YES, LLAMA] });
    expect(choice.backend).toBe("llama-cpp");
    expect(choice.reason).toMatch(/verified bundled/u);
  });

  it("falls back to the bundled engine and says why MLX was skipped", () => {
    const choice = chooseBackend({ parametersBillions: 9, backends: [MLX_NO, LLAMA] });
    expect(choice.backend).toBe("llama-cpp");
    expect(choice.reason).toMatch(/mlx-lm is not installed/u);
  });

  it("lets a measurement on this machine beat the published expectation", () => {
    // 30B would normally go to llama.cpp, but a real measurement wins.
    const choice = chooseBackend({
      parametersBillions: 30,
      backends: [MLX_YES, LLAMA],
      measured: { mlx: 42, "llama-cpp": 21 }
    });
    expect(choice.backend).toBe("mlx");
    expect(choice.reason).toMatch(/100% faster/u);
  });

  it("says they are the same rather than inventing a winner", () => {
    const choice = chooseBackend({
      parametersBillions: 9,
      backends: [MLX_YES, LLAMA],
      measured: { mlx: 40, "llama-cpp": 40 }
    });
    expect(choice.reason).toMatch(/about the same/u);
  });
});

describe("speed is measured, never claimed", () => {
  it("computes tokens per second", () => {
    expect(tokensPerSecond(100, 2_000)).toBe(50);
  });

  it("refuses to divide by nothing", () => {
    expect(tokensPerSecond(100, 0)).toBe(0);
    expect(tokensPerSecond(0, 1_000)).toBe(0);
  });

  it("says it has not been measured rather than quoting a vendor", () => {
    expect(describeSpeed(null)).toBe("Not measured on this Mac yet.");
  });

  it("quotes only a number from a real run", () => {
    const benchmark: Benchmark = {
      backend: "mlx",
      modelId: "Qwen/Qwen3.5-9B",
      tokensPerSecond: 47.4,
      promptTokens: 128,
      generatedTokens: 256,
      measuredAt: "2026-08-21T00:00:00.000Z"
    };
    expect(describeSpeed(benchmark)).toMatch(/^47 tokens\/sec, measured here/u);
  });
});

const ALL: TierAvailability = { localSmall: true, localLarge: true, frontier: true };
const NONE: TierAvailability = { localSmall: false, localLarge: false, frontier: false };

describe("the ladder", () => {
  it("keeps deterministic work off every model", () => {
    expect(route("deterministic", NONE)?.tier).toBe("none");
    expect(worksWithoutAnyEngine("deterministic")).toBe(true);
  });

  it("sends frequent cheap work to the small local model", () => {
    expect(route("classify", ALL)?.tier).toBe("local-small");
    expect(route("extract", ALL)?.tier).toBe("local-small");
  });

  it("sends reasoning to the larger local model", () => {
    expect(route("reason", ALL)?.tier).toBe("local-large");
  });

  it("reserves the frontier tier for what local genuinely cannot do", () => {
    expect(route("whole-folder", ALL)?.tier).toBe("frontier");
    expect(route("write-skill", ALL)?.tier).toBe("frontier");
  });

  it("falls upward when the small model is missing", () => {
    const routing = route("classify", { ...ALL, localSmall: false });
    expect(routing?.tier).toBe("local-large");
    expect(routing?.degraded).toBe(true);
  });

  it("never falls downward into the frontier tier to save a download", () => {
    // Spending someone's quota because they have not installed a small model
    // is a decision they did not make.
    const routing = route("classify", { localSmall: false, localLarge: false, frontier: true });
    expect(routing?.tier).toBe("frontier");
    expect(routing?.degraded).toBe(true);
    // But with a local option present it is never chosen.
    expect(route("classify", ALL)?.tier).toBe("local-small");
  });

  it("returns null rather than pretending when nothing can do it", () => {
    expect(route("reason", NONE)).toBeNull();
    expect(route("whole-folder", NONE)).toBeNull();
  });

  it("names the specific fix instead of saying unavailable", () => {
    expect(explainUnavailable("whole-folder")).toMatch(/connect one/u);
    expect(explainUnavailable("classify")).toMatch(/install one/u);
  });

  it("names who answered, so the person is never guessing", () => {
    expect(route("classify", ALL)?.reason).toMatch(/small local model/u);
    expect(route("whole-folder", ALL)?.reason).toMatch(/connected tool/u);
  });
});
