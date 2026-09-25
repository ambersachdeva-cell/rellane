import { createHash } from "node:crypto";

export const MODULE_PREVIEW_CAP = 50_000;
export const MAX_EXCERPT_LENGTH = 120;

export type ArtifactEditPreviewErrorCode =
  | "STALE_VERSION"
  | "STALE_HASH"
  | "EMPTY_SELECTION"
  | "OUT_OF_RANGE_SELECTION"
  | "NO_OP_EDIT"
  | "INVALID_SURROGATE_BOUNDARY"
  | "PREVIEW_CAP_EXCEEDED"
  | "SCHEMA_LIMIT_EXCEEDED"
  | "INVALID_INPUT";

export class ArtifactEditPreviewError extends Error {
  readonly code: ArtifactEditPreviewErrorCode;

  constructor(code: ArtifactEditPreviewErrorCode, message: string) {
    super(message);
    this.name = "ArtifactEditPreviewError";
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function isSurrogateBoundaryCut(text: string, index: number): boolean {
  if (index <= 0 || index >= text.length) {
    return false;
  }
  const prev = text.charCodeAt(index - 1);
  const curr = text.charCodeAt(index);
  return prev >= 0xd800 && prev <= 0xdbff && curr >= 0xdc00 && curr <= 0xdfff;
}

export function hasUnpairedSurrogates(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (i + 1 >= text.length) {
        return true;
      }
      const next = text.charCodeAt(i + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        return true;
      }
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

export function countLines(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  return text.split(/\r\n|\r|\n/).length;
}

export function createExcerpt(
  text: string,
  maxLength: number = MAX_EXCERPT_LENGTH
): string {
  if (text.length <= maxLength) {
    return text;
  }
  const half = Math.floor((maxLength - 5) / 2);
  const prefix = text.slice(0, half);
  const suffix = text.slice(text.length - half);
  return `${prefix} ... ${suffix}`;
}

export interface Utf16Range {
  readonly start: number;
  readonly end: number;
}

export interface ArtifactEditPreviewOptions {
  readonly currentBody: string;
  readonly currentVersionId: string;
  readonly baseVersionId: string;
  readonly baseSha256: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
  readonly replacement: string;
  readonly scopeLabel?: string | null;
  readonly schemaMaxBodyLength?: number;
}

export interface CodeUnitImpact {
  readonly before: number;
  readonly after: number;
  readonly delta: number;
  readonly totalBefore: number;
  readonly totalAfter: number;
}

export interface LineImpact {
  readonly delta: number;
  readonly totalBefore: number;
  readonly totalAfter: number;
  readonly selectedLines: number;
  readonly replacementLines: number;
}

export interface ExcerptImpact {
  readonly before: string;
  readonly after: string;
}

export interface RegionHashAndLength {
  readonly length: number;
  readonly sha256: string;
}

export interface ArtifactEditPreview {
  readonly affectedScope: Utf16Range;
  readonly userSuppliedScopeLabel: string | null;
  readonly codeUnits: CodeUnitImpact;
  readonly lines: LineImpact;
  readonly excerpts: ExcerptImpact;
  readonly unchangedPrefix: RegionHashAndLength;
  readonly unchangedSuffix: RegionHashAndLength;
  readonly expectedSha256: string;
}

export interface ArtifactEditPreviewResult {
  readonly newBody: string;
  readonly preview: ArtifactEditPreview;
}

export function previewArtifactEdit(
  options: ArtifactEditPreviewOptions
): ArtifactEditPreviewResult {
  if (typeof options !== "object" || options === null) {
    throw new ArtifactEditPreviewError(
      "INVALID_INPUT",
      "Options must be an object."
    );
  }

  const {
    currentBody,
    currentVersionId,
    baseVersionId,
    baseSha256,
    selectionStart,
    selectionEnd,
    replacement,
    scopeLabel,
    schemaMaxBodyLength
  } = options;

  if (typeof currentBody !== "string") {
    throw new ArtifactEditPreviewError(
      "INVALID_INPUT",
      "Current artifact body is required and must be a string."
    );
  }
  if (typeof currentVersionId !== "string" || currentVersionId.length === 0) {
    throw new ArtifactEditPreviewError(
      "INVALID_INPUT",
      "Current version id is required and must be a non-empty string."
    );
  }
  if (typeof baseVersionId !== "string" || baseVersionId.length === 0) {
    throw new ArtifactEditPreviewError(
      "INVALID_INPUT",
      "Base version id is required and must be a non-empty string."
    );
  }
  if (typeof baseSha256 !== "string" || baseSha256.length === 0) {
    throw new ArtifactEditPreviewError(
      "INVALID_INPUT",
      "Base SHA256 is required and must be a non-empty string."
    );
  }
  if (typeof selectionStart !== "number" || typeof selectionEnd !== "number") {
    throw new ArtifactEditPreviewError(
      "INVALID_INPUT",
      "Selection start and selection end must be numbers."
    );
  }
  if (typeof replacement !== "string") {
    throw new ArtifactEditPreviewError(
      "INVALID_INPUT",
      "Replacement text is required and must be a string."
    );
  }

  if (
    schemaMaxBodyLength !== undefined &&
    (typeof schemaMaxBodyLength !== "number" ||
      !Number.isInteger(schemaMaxBodyLength) ||
      schemaMaxBodyLength <= 0)
  ) {
    throw new ArtifactEditPreviewError(
      "INVALID_INPUT",
      "schemaMaxBodyLength must be a positive integer if provided."
    );
  }

  if (currentVersionId !== baseVersionId) {
    throw new ArtifactEditPreviewError(
      "STALE_VERSION",
      `Stale base version: target is ${baseVersionId}, but current version is ${currentVersionId}.`
    );
  }

  const currentSha = sha256Hex(currentBody);
  if (currentSha.toLowerCase() !== baseSha256.toLowerCase()) {
    throw new ArtifactEditPreviewError(
      "STALE_HASH",
      `Stale base hash: expected ${baseSha256}, but current body SHA256 is ${currentSha}.`
    );
  }

  if (!Number.isInteger(selectionStart) || !Number.isInteger(selectionEnd)) {
    throw new ArtifactEditPreviewError(
      "OUT_OF_RANGE_SELECTION",
      "Selection start and end must be integers."
    );
  }

  if (selectionStart < 0 || selectionEnd < 0) {
    throw new ArtifactEditPreviewError(
      "OUT_OF_RANGE_SELECTION",
      `Selection cannot be negative: [${selectionStart}, ${selectionEnd}].`
    );
  }

  if (selectionStart > currentBody.length || selectionEnd > currentBody.length) {
    throw new ArtifactEditPreviewError(
      "OUT_OF_RANGE_SELECTION",
      `Selection [${selectionStart}, ${selectionEnd}] exceeds body length ${currentBody.length}.`
    );
  }

  if (selectionStart > selectionEnd) {
    throw new ArtifactEditPreviewError(
      "OUT_OF_RANGE_SELECTION",
      `Selection start ${selectionStart} cannot exceed selection end ${selectionEnd}.`
    );
  }

  if (selectionStart === selectionEnd) {
    throw new ArtifactEditPreviewError(
      "EMPTY_SELECTION",
      `Selection is empty at offset ${selectionStart}. Editing requires selecting an existing region.`
    );
  }

  if (currentBody.length > MODULE_PREVIEW_CAP) {
    throw new ArtifactEditPreviewError(
      "PREVIEW_CAP_EXCEEDED",
      `Current artifact body length (${currentBody.length}) exceeds this module's preview cap of ${MODULE_PREVIEW_CAP}. Preview is unsupported for bodies exceeding this cap.`
    );
  }

  if (isSurrogateBoundaryCut(currentBody, selectionStart)) {
    throw new ArtifactEditPreviewError(
      "INVALID_SURROGATE_BOUNDARY",
      `Selection start ${selectionStart} cuts across a UTF-16 surrogate pair.`
    );
  }

  if (isSurrogateBoundaryCut(currentBody, selectionEnd)) {
    throw new ArtifactEditPreviewError(
      "INVALID_SURROGATE_BOUNDARY",
      `Selection end ${selectionEnd} cuts across a UTF-16 surrogate pair.`
    );
  }

  if (hasUnpairedSurrogates(replacement)) {
    throw new ArtifactEditPreviewError(
      "INVALID_SURROGATE_BOUNDARY",
      "Replacement text contains unpaired UTF-16 surrogate code units."
    );
  }

  const selectedText = currentBody.slice(selectionStart, selectionEnd);
  if (replacement === selectedText) {
    throw new ArtifactEditPreviewError(
      "NO_OP_EDIT",
      "Replacement is identical to selected text; no-op edits are rejected."
    );
  }

  if (replacement.length > MODULE_PREVIEW_CAP) {
    throw new ArtifactEditPreviewError(
      "PREVIEW_CAP_EXCEEDED",
      `Replacement length (${replacement.length}) exceeds this module's preview cap of ${MODULE_PREVIEW_CAP}.`
    );
  }

  const prefix = currentBody.slice(0, selectionStart);
  const suffix = currentBody.slice(selectionEnd);
  const newBody = prefix + replacement + suffix;

  if (newBody.length > MODULE_PREVIEW_CAP) {
    throw new ArtifactEditPreviewError(
      "PREVIEW_CAP_EXCEEDED",
      `Resulting artifact body length (${newBody.length}) exceeds this module's preview cap of ${MODULE_PREVIEW_CAP}.`
    );
  }

  if (schemaMaxBodyLength !== undefined && newBody.length > schemaMaxBodyLength) {
    throw new ArtifactEditPreviewError(
      "SCHEMA_LIMIT_EXCEEDED",
      `Resulting artifact body length (${newBody.length}) exceeds supplied schema limit of ${schemaMaxBodyLength}.`
    );
  }

  const prefixSha = sha256Hex(prefix);
  const suffixSha = sha256Hex(suffix);
  const expectedSha256 = sha256Hex(newBody);

  const selectedLines = countLines(selectedText);
  const replacementLines = countLines(replacement);
  const totalBeforeLines = countLines(currentBody);
  const totalAfterLines = countLines(newBody);

  const codeUnits: CodeUnitImpact = {
    before: selectedText.length,
    after: replacement.length,
    delta: replacement.length - selectedText.length,
    totalBefore: currentBody.length,
    totalAfter: newBody.length
  };

  const lines: LineImpact = {
    delta: totalAfterLines - totalBeforeLines,
    totalBefore: totalBeforeLines,
    totalAfter: totalAfterLines,
    selectedLines,
    replacementLines
  };

  const excerpts: ExcerptImpact = {
    before: createExcerpt(selectedText),
    after: createExcerpt(replacement)
  };

  const unchangedPrefix: RegionHashAndLength = {
    length: prefix.length,
    sha256: prefixSha
  };

  const unchangedSuffix: RegionHashAndLength = {
    length: suffix.length,
    sha256: suffixSha
  };

  const normalizedScope =
    typeof scopeLabel === "string" && scopeLabel.trim().length > 0
      ? scopeLabel.trim()
      : null;

  const affectedScope: Utf16Range = {
    start: selectionStart,
    end: selectionEnd
  };

  const preview: ArtifactEditPreview = {
    affectedScope,
    userSuppliedScopeLabel: normalizedScope,
    codeUnits,
    lines,
    excerpts,
    unchangedPrefix,
    unchangedSuffix,
    expectedSha256
  };

  return {
    newBody,
    preview
  };
}