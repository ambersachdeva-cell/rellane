import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  previewArtifactEdit,
  ArtifactEditPreviewError,
  sha256Hex,
  MODULE_PREVIEW_CAP
} from "./artifact-edit-preview.js";

describe("artifact-edit-preview", () => {
  it("selection only: leaves outside regions byte-for-byte unchanged", () => {
    const prefix = "Introductory text before selection.\n";
    const selected = "Old version of the selected text.";
    const suffix = "\nConcluding paragraph that must remain byte-for-byte intact.";
    const currentBody = prefix + selected + suffix;
    const versionId = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
    const baseSha256 = sha256Hex(currentBody);

    const start = prefix.length;
    const end = prefix.length + selected.length;
    const replacement = "Brand new updated text.";

    const result = previewArtifactEdit({
      currentBody,
      currentVersionId: versionId,
      baseVersionId: versionId,
      baseSha256,
      selectionStart: start,
      selectionEnd: end,
      replacement,
      scopeLabel: "Target Paragraph"
    });

    assert.equal(result.newBody, prefix + replacement + suffix);
    assert.equal(result.newBody.slice(0, start), prefix);
    assert.equal(result.newBody.slice(start + replacement.length), suffix);

    assert.equal(
      Buffer.from(result.newBody.slice(0, start)).equals(Buffer.from(prefix)),
      true
    );
    assert.equal(
      Buffer.from(result.newBody.slice(start + replacement.length)).equals(
        Buffer.from(suffix)
      ),
      true
    );

    assert.equal(result.preview.unchangedPrefix.length, prefix.length);
    assert.equal(result.preview.unchangedPrefix.sha256, sha256Hex(prefix));
    assert.equal(result.preview.unchangedSuffix.length, suffix.length);
    assert.equal(result.preview.unchangedSuffix.sha256, sha256Hex(suffix));
    assert.deepEqual(result.preview.affectedScope, { start, end });
    assert.equal(result.preview.userSuppliedScopeLabel, "Target Paragraph");
    assert.equal(result.preview.expectedSha256, sha256Hex(result.newBody));
  });

  it("rejects treating owner-provided scopeLabel as evidence and marks it user-supplied", () => {
    const currentBody = "const alpha = 1;\nconst beta = 2;\nconst gamma = 3;";
    const versionId = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
    const baseSha256 = sha256Hex(currentBody);
    const start = currentBody.indexOf("const beta = 2;");
    const end = start + "const beta = 2;".length;

    const result = previewArtifactEdit({
      currentBody,
      currentVersionId: versionId,
      baseVersionId: versionId,
      baseSha256,
      selectionStart: start,
      selectionEnd: end,
      replacement: "const beta = 200;",
      scopeLabel: "Entire Program File"
    });

    assert.notEqual(result.preview.affectedScope, "Entire Program File");
    assert.deepEqual(result.preview.affectedScope, { start, end });
    assert.equal(result.preview.userSuppliedScopeLabel, "Entire Program File");
  });

  it("computes accurate line delta at newline boundaries without false delta", () => {
    const body1 = "alpha\nbeta\ngamma";
    const start1 = body1.indexOf("\nbeta");
    const end1 = start1 + "\nbeta".length;
    const result1 = previewArtifactEdit({
      currentBody: body1,
      currentVersionId: "v1",
      baseVersionId: "v1",
      baseSha256: sha256Hex(body1),
      selectionStart: start1,
      selectionEnd: end1,
      replacement: ""
    });
    assert.equal(result1.newBody, "alpha\ngamma");
    assert.equal(result1.preview.lines.totalBefore, 3);
    assert.equal(result1.preview.lines.totalAfter, 2);
    assert.equal(
      result1.preview.lines.delta,
      result1.preview.lines.totalAfter - result1.preview.lines.totalBefore
    );
    assert.equal(result1.preview.lines.delta, -1);
    assert.equal(result1.preview.lines.selectedLines, 2);
    assert.equal(result1.preview.lines.replacementLines, 0);

    const body2 = "single line text";
    const start2 = body2.indexOf("line");
    const end2 = start2 + "line".length;
    const result2 = previewArtifactEdit({
      currentBody: body2,
      currentVersionId: "v1",
      baseVersionId: "v1",
      baseSha256: sha256Hex(body2),
      selectionStart: start2,
      selectionEnd: end2,
      replacement: ""
    });
    assert.equal(result2.newBody, "single  text");
    assert.equal(result2.preview.lines.totalBefore, 1);
    assert.equal(result2.preview.lines.totalAfter, 1);
    assert.equal(result2.preview.lines.delta, 0);
    assert.equal(
      result2.preview.lines.delta,
      result2.preview.lines.totalAfter - result2.preview.lines.totalBefore
    );
    assert.equal(result2.preview.lines.selectedLines, 1);
    assert.equal(result2.preview.lines.replacementLines, 0);

    const body3 = "Line 1\r\nLine 2 to replace\r\nLine 3 to replace\r\nLine 4";
    const start3 = body3.indexOf("Line 2");
    const end3 = body3.indexOf("\r\nLine 4");
    const result3 = previewArtifactEdit({
      currentBody: body3,
      currentVersionId: "v1",
      baseVersionId: "v1",
      baseSha256: sha256Hex(body3),
      selectionStart: start3,
      selectionEnd: end3,
      replacement: "Single replaced row"
    });
    assert.equal(
      result3.newBody,
      "Line 1\r\nSingle replaced row\r\nLine 4"
    );
    assert.equal(result3.preview.lines.totalBefore, 4);
    assert.equal(result3.preview.lines.totalAfter, 3);
    assert.equal(result3.preview.lines.delta, -1);
    assert.equal(
      result3.preview.lines.delta,
      result3.preview.lines.totalAfter - result3.preview.lines.totalBefore
    );
    assert.equal(result3.preview.lines.selectedLines, 2);
    assert.equal(result3.preview.lines.replacementLines, 1);
  });

  it("rejects no-op edits where replacement equals selected text", () => {
    const currentBody = "Prefix middle suffix";
    const versionId = "v-noop";
    const baseSha256 = sha256Hex(currentBody);
    const start = 7;
    const end = 13;

    assert.throws(
      () =>
        previewArtifactEdit({
          currentBody,
          currentVersionId: versionId,
          baseVersionId: versionId,
          baseSha256,
          selectionStart: start,
          selectionEnd: end,
          replacement: "middle"
        }),
      (err: unknown) => {
        assert.ok(err instanceof ArtifactEditPreviewError);
        assert.equal(err.code, "NO_OP_EDIT");
        return true;
      }
    );
  });

  it("handles emoji and surrogate pairs, rejecting cuts and unpaired surrogates", () => {
    const body = "Greeting 😀 world 🚀 test";
    const versionId = "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d";
    const baseSha256 = sha256Hex(body);

    assert.equal(body.charCodeAt(9) >= 0xd800 && body.charCodeAt(9) <= 0xdbff, true);
    assert.equal(body.charCodeAt(10) >= 0xdc00 && body.charCodeAt(10) <= 0xdfff, true);

    assert.throws(
      () =>
        previewArtifactEdit({
          currentBody: body,
          currentVersionId: versionId,
          baseVersionId: versionId,
          baseSha256,
          selectionStart: 10,
          selectionEnd: 17,
          replacement: "friend"
        }),
      (err: unknown) => {
        assert.ok(err instanceof ArtifactEditPreviewError);
        assert.equal(err.code, "INVALID_SURROGATE_BOUNDARY");
        return true;
      }
    );

    assert.throws(
      () =>
        previewArtifactEdit({
          currentBody: body,
          currentVersionId: versionId,
          baseVersionId: versionId,
          baseSha256,
          selectionStart: 0,
          selectionEnd: 10,
          replacement: "Hello"
        }),
      (err: unknown) => {
        assert.ok(err instanceof ArtifactEditPreviewError);
        assert.equal(err.code, "INVALID_SURROGATE_BOUNDARY");
        return true;
      }
    );

    assert.throws(
      () =>
        previewArtifactEdit({
          currentBody: body,
          currentVersionId: versionId,
          baseVersionId: versionId,
          baseSha256,
          selectionStart: 0,
          selectionEnd: 8,
          replacement: "Unpaired \uD83D high surrogate"
        }),
      (err: unknown) => {
        assert.ok(err instanceof ArtifactEditPreviewError);
        assert.equal(err.code, "INVALID_SURROGATE_BOUNDARY");
        return true;
      }
    );

    assert.throws(
      () =>
        previewArtifactEdit({
          currentBody: body,
          currentVersionId: versionId,
          baseVersionId: versionId,
          baseSha256,
          selectionStart: 0,
          selectionEnd: 8,
          replacement: "Unpaired \uDE00 low surrogate"
        }),
      (err: unknown) => {
        assert.ok(err instanceof ArtifactEditPreviewError);
        assert.equal(err.code, "INVALID_SURROGATE_BOUNDARY");
        return true;
      }
    );

    const validResult = previewArtifactEdit({
      currentBody: body,
      currentVersionId: versionId,
      baseVersionId: versionId,
      baseSha256,
      selectionStart: 9,
      selectionEnd: 11,
      replacement: "🎉"
    });

    assert.equal(validResult.newBody, "Greeting 🎉 world 🚀 test");
    assert.equal(validResult.preview.codeUnits.before, 2);
    assert.equal(validResult.preview.codeUnits.after, 2);
    assert.equal(validResult.preview.codeUnits.delta, 0);
    assert.equal(validResult.preview.expectedSha256, sha256Hex(validResult.newBody));
  });

  it("refuses stale version and stale hash", () => {
    const body = "Line 1\nLine 2\nLine 3";
    const validVersionId = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
    const staleVersionId = "11111111-2222-3333-4444-555555555555";
    const validSha = sha256Hex(body);
    const staleSha = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

    assert.throws(
      () =>
        previewArtifactEdit({
          currentBody: body,
          currentVersionId: validVersionId,
          baseVersionId: staleVersionId,
          baseSha256: validSha,
          selectionStart: 0,
          selectionEnd: 6,
          replacement: "Replaced"
        }),
      (err: unknown) => {
        assert.ok(err instanceof ArtifactEditPreviewError);
        assert.equal(err.code, "STALE_VERSION");
        return true;
      }
    );

    assert.throws(
      () =>
        previewArtifactEdit({
          currentBody: body,
          currentVersionId: validVersionId,
          baseVersionId: validVersionId,
          baseSha256: staleSha,
          selectionStart: 0,
          selectionEnd: 6,
          replacement: "Replaced"
        }),
      (err: unknown) => {
        assert.ok(err instanceof ArtifactEditPreviewError);
        assert.equal(err.code, "STALE_HASH");
        return true;
      }
    );
  });

  it("enforces module preview cap and schema limit without claiming global app limit", () => {
    const oversizeBody = "a".repeat(MODULE_PREVIEW_CAP + 1);
    const versionId = "e5096123-2895-46e3-a60d-9b51829676e1";
    const baseSha256 = sha256Hex(oversizeBody);

    assert.throws(
      () =>
        previewArtifactEdit({
          currentBody: oversizeBody,
          currentVersionId: versionId,
          baseVersionId: versionId,
          baseSha256,
          selectionStart: 0,
          selectionEnd: 10,
          replacement: "safe"
        }),
      (err: unknown) => {
        assert.ok(err instanceof ArtifactEditPreviewError);
        assert.equal(err.code, "PREVIEW_CAP_EXCEEDED");
        assert.match(err.message, /preview cap/i);
        return true;
      }
    );

    const normalBody = "Short body for schema test";
    const normalSha = sha256Hex(normalBody);
    assert.throws(
      () =>
        previewArtifactEdit({
          currentBody: normalBody,
          currentVersionId: versionId,
          baseVersionId: versionId,
          baseSha256: normalSha,
          selectionStart: 0,
          selectionEnd: 5,
          replacement: "A very long replacement string exceeding schema limit",
          schemaMaxBodyLength: 30
        }),
      (err: unknown) => {
        assert.ok(err instanceof ArtifactEditPreviewError);
        assert.equal(err.code, "SCHEMA_LIMIT_EXCEEDED");
        assert.match(err.message, /schema limit/i);
        return true;
      }
    );
  });

  it("refuses empty and out-of-range selections", () => {
    const body = "Selection test string";
    const versionId = "a2a514d2-23c2-482a-a55d-b2b9c755ec50";
    const baseSha256 = sha256Hex(body);

    assert.throws(
      () =>
        previewArtifactEdit({
          currentBody: body,
          currentVersionId: versionId,
          baseVersionId: versionId,
          baseSha256,
          selectionStart: 5,
          selectionEnd: 5,
          replacement: "insertion"
        }),
      (err: unknown) => {
        assert.ok(err instanceof ArtifactEditPreviewError);
        assert.equal(err.code, "EMPTY_SELECTION");
        return true;
      }
    );

    assert.throws(
      () =>
        previewArtifactEdit({
          currentBody: body,
          currentVersionId: versionId,
          baseVersionId: versionId,
          baseSha256,
          selectionStart: -1,
          selectionEnd: 5,
          replacement: "neg"
        }),
      (err: unknown) => {
        assert.ok(err instanceof ArtifactEditPreviewError);
        assert.equal(err.code, "OUT_OF_RANGE_SELECTION");
        return true;
      }
    );

    assert.throws(
      () =>
        previewArtifactEdit({
          currentBody: body,
          currentVersionId: versionId,
          baseVersionId: versionId,
          baseSha256,
          selectionStart: 10,
          selectionEnd: 5,
          replacement: "inverted"
        }),
      (err: unknown) => {
        assert.ok(err instanceof ArtifactEditPreviewError);
        assert.equal(err.code, "OUT_OF_RANGE_SELECTION");
        return true;
      }
    );

    assert.throws(
      () =>
        previewArtifactEdit({
          currentBody: body,
          currentVersionId: versionId,
          baseVersionId: versionId,
          baseSha256,
          selectionStart: 0,
          selectionEnd: 1000,
          replacement: "beyond"
        }),
      (err: unknown) => {
        assert.ok(err instanceof ArtifactEditPreviewError);
        assert.equal(err.code, "OUT_OF_RANGE_SELECTION");
        return true;
      }
    );
  });

  it("produces deterministic hashes and truthful scope output across repeated runs", () => {
    const body = "First sentence. Middle target section. Last sentence.";
    const versionId = "6a40a5a4-949f-4318-971c-7b0662d512a1";
    const baseSha256 = sha256Hex(body);

    const input = {
      currentBody: body,
      currentVersionId: versionId,
      baseVersionId: versionId,
      baseSha256,
      selectionStart: 16,
      selectionEnd: 38,
      replacement: "New refined section.",
      scopeLabel: "Middle"
    };

    const run1 = previewArtifactEdit(input);
    const run2 = previewArtifactEdit(input);

    assert.equal(run1.newBody, run2.newBody);
    assert.equal(run1.preview.expectedSha256, run2.preview.expectedSha256);
    assert.equal(run1.preview.expectedSha256, sha256Hex(run1.newBody));
    assert.equal(
      run1.preview.unchangedPrefix.sha256,
      run2.preview.unchangedPrefix.sha256
    );
    assert.equal(
      run1.preview.unchangedSuffix.sha256,
      run2.preview.unchangedSuffix.sha256
    );
    assert.deepEqual(run1.preview.affectedScope, { start: 16, end: 38 });
    assert.equal(run1.preview.userSuppliedScopeLabel, "Middle");
  });
});
