/** Imported visual work stays local and keeps its original bytes. No paths or grants cross the bridge. */
import { z } from "zod";
import { WorkstationCaseIdSchema } from "./workstation-projects.js";

export type WorkstationImageMime = "image/png" | "image/jpeg";

export interface WorkstationImageAsset {
  readonly id: string;
  readonly caseId: string;
  readonly title: string;
  readonly fileName: string;
  readonly mime: WorkstationImageMime;
  readonly width: number;
  readonly height: number;
  readonly byteLength: number;
  readonly sha256: string;
  readonly createdAt: number;
}

export interface WorkstationImageAssetSaveInput {
  readonly caseId: string;
  readonly title: string;
  readonly fileName: string;
  readonly mime: WorkstationImageMime;
  readonly width: number;
  readonly height: number;
  readonly content: Uint8Array;
}

export interface WorkstationImageReadResult {
  readonly asset: WorkstationImageAsset;
  readonly content: Uint8Array;
}

export const MAX_IMAGE_BYTE_LENGTH = 8 * 1024 * 1024; // 8 MiB (8,388,608 bytes)
export const MAX_IMAGE_PIXELS = 16_000_000; // 16 million total pixels
export const MAX_IMAGE_DIMENSION = 4096;

/** Prohibits ASCII control characters (0-31, 127) as well as slashes and backslashes. */
const CONTROL_OR_SLASH_REGEX = /[\u0000-\u001f\u007f/\\]/;

export const WorkstationImageIdSchema = z.string().uuid();

export const WorkstationImageTitleSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine(
    (val) => !/[\u0000-\u001f\u007f]/u.test(val),
    "Title must not contain control characters."
  );

export const WorkstationImageFileNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine(
    (val) => !CONTROL_OR_SLASH_REGEX.test(val),
    "Filename must not contain slashes, backslashes, or control characters."
  );

export const WorkstationImageMimeSchema = z.enum(["image/png", "image/jpeg"]);

export const WorkstationImageDimensionSchema = z
  .number()
  .int()
  .min(1)
  .max(MAX_IMAGE_DIMENSION);

export const WorkstationImageContentSchema = z
  .instanceof(Uint8Array)
  .refine(
    (bytes) => bytes.byteLength > 0 && bytes.byteLength <= MAX_IMAGE_BYTE_LENGTH,
    "Image content must be non-empty and at most 8 MiB."
  );

export const WorkstationImageAssetSaveInputSchema = z
  .strictObject({
    caseId: WorkstationCaseIdSchema,
    title: WorkstationImageTitleSchema,
    fileName: WorkstationImageFileNameSchema,
    mime: WorkstationImageMimeSchema,
    width: WorkstationImageDimensionSchema,
    height: WorkstationImageDimensionSchema,
    content: WorkstationImageContentSchema
  })
  .refine(
    (input) => input.width * input.height <= MAX_IMAGE_PIXELS,
    {
      message: "Total pixels (width * height) cannot exceed 16 million pixels."
    }
  );

export const WorkstationImageAssetSchema = z.strictObject({
  id: WorkstationImageIdSchema,
  caseId: WorkstationCaseIdSchema,
  title: WorkstationImageTitleSchema,
  fileName: WorkstationImageFileNameSchema,
  mime: WorkstationImageMimeSchema,
  width: WorkstationImageDimensionSchema,
  height: WorkstationImageDimensionSchema,
  byteLength: z.number().int().positive().max(MAX_IMAGE_BYTE_LENGTH),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  createdAt: z.number().int().nonnegative()
});

export const WorkstationImageCaseRequestSchema = z.strictObject({ caseId: WorkstationCaseIdSchema });
export const WorkstationImageReadRequestSchema = z.strictObject({ caseId: WorkstationCaseIdSchema, id: WorkstationImageIdSchema });
export const WorkstationImagePreviewRequestSchema = WorkstationImageReadRequestSchema.extend({ size: z.enum(["thumbnail", "detail"]) });
export interface WorkstationImagePreview { readonly asset: WorkstationImageAsset; readonly dataUrl: string; }
export interface WorkstationImageExport { readonly written: boolean; readonly fileName: string | null; readonly sha256: string | null; }
