import { expect, it, vi } from "vitest";
import type { ModelLicenseReview } from "@cadrane/contracts";
import { createModelReview } from "./model-review.js";

const review: ModelLicenseReview = { modelId: "fictional-model", displayName: "Fictional model",
  artifactSha256: "a".repeat(64), downloadBytes: 1024, catalogGeneration: 1,
  sourceHost: "huggingface.co", repository: "Fixture/Test-GGUF",
  licenseId: "fixture", licenseName: "Fixture terms", licenseNoticeVersion: "one",
  licenseNoticeSha256: "b".repeat(64), noticeText: "Fictional licence notice.", acknowledgementCurrent: false };
function setup() {
  const api = { licenseReview: vi.fn().mockResolvedValue(review), acknowledgeLicense: vi.fn().mockResolvedValue({}),
    install: vi.fn().mockResolvedValue({}) };
  return { api, flow: createModelReview(api) };
}

it("opens and closes a notice without accepting terms or starting a download", async () => {
  const { api, flow } = setup();
  const opened = await flow.open(review.modelId, true);
  expect(opened).toEqual(review); expect(Object.isFrozen(opened)).toBe(true);
  flow.close();
  await expect(flow.confirm(opened!)).rejects.toThrow("cannot be installed");
  expect(api.acknowledgeLicense).not.toHaveBeenCalled(); expect(api.install).not.toHaveBeenCalled();
});

it("requires an eligible current review and rejects a copied or superseded notice", async () => {
  const { api, flow } = setup();
  const blocked = await flow.open(review.modelId, false);
  await expect(flow.confirm(blocked!)).rejects.toThrow("cannot be installed");
  const old = await flow.open(review.modelId, true);
  const current = await flow.open(review.modelId, true);
  await expect(flow.confirm(old!)).rejects.toThrow("cannot be installed");
  await expect(flow.confirm({ ...current! })).rejects.toThrow("cannot be installed");
  expect(api.acknowledgeLicense).not.toHaveBeenCalled(); expect(api.install).not.toHaveBeenCalled();
});

it("accepts the exact notice once and waits for acknowledgement before downloading", async () => {
  const { api, flow } = setup(); let accept!: () => void;
  api.acknowledgeLicense.mockImplementation(() => new Promise<void>(resolve => { accept = resolve; }));
  const current = await flow.open(review.modelId, true);
  const start = flow.confirm(current!);
  expect(api.install).not.toHaveBeenCalled();
  await expect(flow.confirm(current!)).rejects.toThrow("cannot be installed");
  expect(api.acknowledgeLicense).toHaveBeenCalledExactlyOnceWith({ modelId: review.modelId,
    artifactSha256: review.artifactSha256, catalogGeneration: 1, licenseNoticeVersion: "one",
    licenseNoticeSha256: review.licenseNoticeSha256, accepted: true });
  accept(); await start;
  expect(api.install).toHaveBeenCalledExactlyOnceWith(review.modelId);
});

it("discards a cancelled late read instead of replacing a newer review", async () => {
  const { api, flow } = setup(); let finish!: (value: unknown) => void;
  api.licenseReview.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const old = flow.open(review.modelId, true); flow.close();
  const current = await flow.open(review.modelId, false);
  finish({ ...review, modelId: "different-model" });
  expect(await old).toBeNull();
  await expect(flow.confirm(current!)).rejects.toThrow("cannot be installed");
  expect(api.acknowledgeLicense).not.toHaveBeenCalled(); expect(api.install).not.toHaveBeenCalled();
});

it("does not download if acknowledgement fails or the review closes while acceptance finishes", async () => {
  const { api, flow } = setup();
  api.acknowledgeLicense.mockRejectedValueOnce(new Error("Fictional acceptance failure"));
  await expect(flow.confirm((await flow.open(review.modelId, true))!)).rejects.toThrow("acceptance failure");
  let accept!: () => void;
  api.acknowledgeLicense.mockImplementationOnce(() => new Promise<void>(resolve => { accept = resolve; }));
  const pending = flow.confirm((await flow.open(review.modelId, true))!);
  const rejected = expect(pending).rejects.toThrow("before the download started");
  flow.close(); accept(); await rejected;
  expect(api.install).not.toHaveBeenCalled();
});

it("refuses a review for a different model without creating an acceptance", async () => {
  const { api, flow } = setup();
  api.licenseReview.mockResolvedValue({ ...review, modelId: "other-model" });
  await expect(flow.open(review.modelId, true)).rejects.toThrow("does not match");
  expect(api.acknowledgeLicense).not.toHaveBeenCalled(); expect(api.install).not.toHaveBeenCalled();
});
