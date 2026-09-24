// Reading a bill that arrived as a photograph or a PDF.
//
// A trader does not type bills. A bill arrives as a photo on WhatsApp or a PDF
// from Tally, and the paste-a-bill feature could only take text — which meant
// the fastest path into the book started with retyping. This closes that.
//
// PDFKit supplies a digital PDF's text. Vision reads photographs and scans.
// Both are local platform frameworks; neither proves a field's meaning or an
// issuer's authenticity. Barcode payloads are unverified observations and are
// never substituted for bill text. A usable PDF text layer needs no image pass.
//
// Writes JSON to stdout and nothing else, so the caller parses one thing.

import Foundation
import Vision
import PDFKit
import AppKit

struct Result: Encodable {
    var ok: Bool
    var source: String        // "qr" | "pdf-text" | "ocr" | "none"
    var text: String
    var codes: [String]
    var problem: String?
}

func emit(_ result: Result) -> Never {
    let data = (try? JSONEncoder().encode(result)) ?? Data("{\"ok\":false}".utf8)
    FileHandle.standardOutput.write(data)
    exit(result.ok ? 0 : 1)
}

func fail(_ why: String) -> Never {
    emit(Result(ok: false, source: "none", text: "", codes: [], problem: why))
}

/// Text and any barcodes in one image, using Vision.
func readImage(_ image: CGImage) -> (text: String, codes: [String]) {
    let handler = VNImageRequestHandler(cgImage: image, options: [:])

    let textRequest = VNRecognizeTextRequest()
    textRequest.recognitionLevel = .accurate
    // Devanagari alongside English: a bill from a local supplier is regularly
    // part Hindi, and dropping those lines loses the party name.
    textRequest.recognitionLanguages = ["en-IN", "en-US", "hi-IN"]
    textRequest.usesLanguageCorrection = false  // A GSTIN is not a word.

    let codeRequest = VNDetectBarcodesRequest()

    try? handler.perform([textRequest, codeRequest])

    // Sorted top-to-bottom, then left-to-right, so the output reads like the
    // page. Vision returns observations in confidence order, which on an
    // invoice scrambles the totals into the middle of the address.
    let lines = (textRequest.results ?? [])
        .sorted { a, b in
            let ay = a.boundingBox.midY, by = b.boundingBox.midY
            // Same row within a small tolerance, so columns stay side by side.
            if abs(ay - by) > 0.012 { return ay > by }
            return a.boundingBox.minX < b.boundingBox.minX
        }
        .compactMap { $0.topCandidates(1).first?.string }

    let codes = (codeRequest.results ?? []).compactMap { $0.payloadStringValue }
    return (lines.joined(separator: "\n"), codes)
}

let arguments = CommandLine.arguments
guard arguments.count == 2 else {
    fail("Usage: read-document <path>")
}
let path = arguments[1]
guard FileManager.default.fileExists(atPath: path) else {
    fail("There is no file at that path.")
}
let url = URL(fileURLWithPath: path)

if path.lowercased().hasSuffix(".pdf") {
    guard let document = PDFDocument(url: url) else {
        fail("That PDF could not be opened.")
    }

    var text = ""
    for index in 0..<min(document.pageCount, 10) {
        text += document.page(at: index)?.string ?? ""
    }

    // Enough characters to be a real text layer. A scanned PDF often carries a
    // handful of stray glyphs, and treating those as the document produces an
    // empty bill rather than an honest fall back to OCR.
    if text.trimmingCharacters(in: .whitespacesAndNewlines).count > 80 {
        emit(Result(ok: true, source: "pdf-text", text: text, codes: [], problem: nil))
    }

    // No usable text layer: it is a scan. Render and read it.
    guard let page = document.page(at: 0) else {
        fail("That PDF has no pages.")
    }
    let bounds = page.bounds(for: .mediaBox)
    // 2×, which is roughly 144dpi for a typical page — enough for Vision on
    // printed text without turning a ten-page PDF into a memory problem.
    let scale: CGFloat = 2
    let size = NSSize(width: bounds.width * scale, height: bounds.height * scale)
    let rendered = NSImage(size: size, flipped: false) { rect in
        NSColor.white.setFill()
        rect.fill()
        guard let context = NSGraphicsContext.current?.cgContext else { return true }
        context.scaleBy(x: scale, y: scale)
        page.draw(with: .mediaBox, to: context)
        return true
    }
    guard let cg = rendered.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
        fail("That page could not be rendered.")
    }
    let read = readImage(cg)
    emit(Result(ok: !read.text.isEmpty, source: "ocr", text: read.text, codes: read.codes,
                problem: read.text.isEmpty ? "Nothing readable was found on that page." : nil))
}

guard let image = NSImage(contentsOf: url),
      let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    fail("That file is not an image Rellane can read.")
}
let read = readImage(cg)
emit(Result(ok: !read.text.isEmpty || !read.codes.isEmpty,
            source: read.codes.isEmpty ? "ocr" : "qr",
            text: read.text,
            codes: read.codes,
            problem: (read.text.isEmpty && read.codes.isEmpty)
                ? "Nothing readable was found in that image."
                : nil))
