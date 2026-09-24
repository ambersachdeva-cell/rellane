/**
 * The install guide has to stay true.
 *
 * A document like this rots silently: the app changes, the instructions do not,
 * and the first person to follow them is the one who finds out. These check the
 * handful of facts in it that the build itself decides.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const guide = () => readFile(join(root, "docs", "INSTALL.md"), "utf8");
const manifest = async () =>
  JSON.parse(await readFile(join(root, "apps", "desktop", "package.json"), "utf8")) as {
    version: string;
    build: { mac: { target: unknown[]; notarize: boolean }; dmg: { writeUpdateInfo: boolean } };
  };

describe("what the guide promises about the build", () => {
  it("names the version that is actually built", async () => {
    // The download in the guide is named. A version bump that leaves this
    // behind sends somebody looking for a file that does not exist.
    const { version } = await manifest();

    expect(await guide()).toContain(`Cadrane-${version}-arm64.dmg`);
  });

  it("still admits Gatekeeper rejects this signing identity", async () => {
    // The day this stops being true is the day a Developer ID certificate is
    // bought, and on that day this paragraph must be rewritten rather than
    // quietly left standing.
    const { build } = await manifest();
    const text = await guide();

    expect(build.mac.notarize).toBe(false);
    expect(text).toContain("Apple Development");
    expect(text).toContain("rejected");
    expect(text).toContain("xattr -dr com.apple.quarantine");
  });

  it("does not describe an updater the product refuses to have", async () => {
    const { build } = await manifest();
    const text = await guide();

    // `writeUpdateInfo` publishes a feed for an auto-updater. There is no
    // auto-updater by decision, so advertising one would be a promise the
    // product has deliberately not made.
    expect(build.dmg.writeUpdateInfo).toBe(false);
    expect(text).toContain("never updates itself");
    expect(text).toContain("Every folder grant is withdrawn");
  });

  it("names the one folder that holds everything", async () => {
    // If this path ever moves, somebody following the uninstall instructions
    // leaves their entire business on the disk believing they removed it.
    const home = await readFile(
      join(root, "apps", "desktop", "src", "main", "foundations", "home.ts"),
      "utf8"
    );
    const name = /HOME_DIR_NAME = "([^"]+)"/u.exec(home)?.[1];

    // Still "Cadrane" after the Rellane rename, and deliberately so: this is
    // the directory on disk, not the product's name. See foundations/home.ts.
    expect(name).toBe("Cadrane");
    expect(await guide()).toContain(`~/Library/Application Support/${name}/`);
  });
});
