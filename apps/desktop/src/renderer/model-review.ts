import { ModelLicenseReviewSchema, type DesktopBridge, type ModelLicenseReview } from "@cadrane/contracts";

type ModelApi = Pick<DesktopBridge["models"], "licenseReview" | "acknowledgeLicense" | "install">;

/** Opening a notice is read-only. Only a separate confirmation can consume it. */
export function createModelReview(api: ModelApi) {
  let revision = 0;
  let current: { review: ModelLicenseReview; installable: boolean; revision: number } | null = null;
  let confirming = false;

  return {
    async open(modelId: string, installable: boolean): Promise<ModelLicenseReview | null> {
      if (confirming) throw new Error("A model installation is already starting. Wait for it to finish or stop it first.");
      const request = ++revision;
      current = null;
      try {
        const review = Object.freeze(ModelLicenseReviewSchema.parse(await api.licenseReview(modelId)));
        if (request !== revision) return null;
        if (review.modelId !== modelId) throw new Error("The returned model does not match this review. Open it again.");
        current = { review, installable, revision: request };
        return review;
      } catch (error) {
        if (request !== revision) return null;
        throw error;
      }
    },

    close(): void { revision++; current = null; },

    async confirm(review: ModelLicenseReview): Promise<void> {
      const selected = current;
      if (!selected || selected.review !== review || !selected.installable || confirming)
        throw new Error("This model cannot be installed from this review. Check its current availability first.");
      // Claim before the first await; double clicks cannot acknowledge or start twice.
      current = null;
      confirming = true;
      try {
        await api.acknowledgeLicense({ modelId: review.modelId, artifactSha256: review.artifactSha256,
          catalogGeneration: review.catalogGeneration, licenseNoticeVersion: review.licenseNoticeVersion,
          licenseNoticeSha256: review.licenseNoticeSha256, accepted: true });
        if (revision !== selected.revision)
          throw new Error("Closed before the download started. The licence acceptance may already be recorded.");
        await api.install(review.modelId);
      } finally { confirming = false; }
    }
  };
}
