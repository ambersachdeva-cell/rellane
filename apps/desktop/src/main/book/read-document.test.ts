import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ root: "" }));
vi.mock("electron", () => ({ app: { isPackaged: false, getAppPath: () => fixture.root + "/apps/desktop" } }));
import { readDocument } from "./read-document.js";

const controllers: AbortController[] = [];
beforeEach(async () => {
  fixture.root = await mkdtemp(join(tmpdir(), "cadrane-document-stop-"));
  await mkdir(join(fixture.root, "native/read-document"), { recursive: true });
});
afterEach(async () => {
  for (const controller of controllers.splice(0)) controller.abort();
  await rm(fixture.root, { recursive: true, force: true });
});
async function helper(body: string) {
  await writeFile(join(fixture.root, "native/read-document/read-document"), `#!${process.execPath}\n${body}\n`, { mode: 0o700 });
}

it("actually terminates its bounded helper on Stop and returns no late document", async () => {
  const pidPath = join(fixture.root, "owned-helper.pid");
  await helper("require('node:fs').writeFileSync(process.argv[2], String(process.pid)); setTimeout(() => console.log(JSON.stringify({ok:true,source:'ocr',text:'late fictional bill',codes:[]})), 10000);");
  const stop = new AbortController(); controllers.push(stop);
  const pending = readDocument(pidPath, stop.signal);
  let pid = 0;
  await vi.waitFor(async () => { pid = Number(await readFile(pidPath, "utf8")); expect(pid).toBeGreaterThan(1); });
  stop.abort();
  expect(await pending).toMatchObject({ ok: false, text: "", source: "none", said: expect.stringContaining("stopped") });
  await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
});

it("does not call OCR text exact or authenticated merely because a barcode was detected", async () => {
  await helper("console.log(JSON.stringify({ok:true,source:'qr',text:'Fictional total 1,050.50',codes:['fictional unverified barcode']}));");
  const result = await readDocument(join(fixture.root, "fictional.pdf"));
  expect(result).toMatchObject({ ok: true, source: "ocr", text: "Fictional total 1,050.50" });
  expect(result.said).toContain("OCR"); expect(result.said).toContain("have not been verified");
  expect(result.said).not.toContain("exactly");
  await helper("console.log(JSON.stringify({ok:true,source:'qr',text:'',codes:['fictional unverified barcode']}));");
  expect(await readDocument(join(fixture.root, "fictional.pdf"))).toMatchObject({ ok: false, text: "", source: "none" });
});
