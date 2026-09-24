/** Business outputs must leave the app as editable documents without fetching
 * images, opening links, executing markup or depending on a hosted converter. */
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from "docx";
import type { CaseArtifactVersion } from "@cadrane/contracts";

const invalidXml = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/u;

export async function renderWorkroomDocx(
  title: string,
  version: CaseArtifactVersion
): Promise<Buffer> {
  if (
    !title.isWellFormed() ||
    !version.body.isWellFormed() ||
    invalidXml.test(title + version.body)
  ) {
    throw new Error(
      "The output contains a character Word cannot save. Remove control characters and try again."
    );
  }
  if (
    title.length > 240 ||
    version.body.length > 50_000 ||
    !version.body.trim()
  ) {
    throw new Error("The output is empty or too long to export.");
  }
  const children: Paragraph[] = [
    new Paragraph({ text: title, heading: HeadingLevel.TITLE }),
    new Paragraph({
      children: [
        new TextRun({
          text: `Version ${version.revision} · ${version.acceptedAt === null ? "Draft — not accepted" : "Accepted by owner"}`,
          size: 20,
          color: "555555"
        })
      ],
      spacing: { after: 280 }
    })
  ];
  for (const line of version.body.replace(/\r\n?/gu, "\n").split("\n")) {
    // Paragraph styles already provide separation. Markdown's empty separator
    // lines must not double it and strand a short handoff on an extra page.
    if (!line.trim()) continue;
    const heading = /^(#{1,3})\s+(.+)$/u.exec(line);
    const bullet = /^[-*]\s+(.+)$/u.exec(line);
    if (heading) {
      const levels = [
        HeadingLevel.HEADING_1,
        HeadingLevel.HEADING_2,
        HeadingLevel.HEADING_3
      ] as const;
      children.push(
        new Paragraph({
          text: heading[2]!,
          heading: levels[heading[1]!.length - 1]!
        })
      );
    } else if (bullet) {
      children.push(new Paragraph({ text: bullet[1]!, bullet: { level: 0 } }));
    } else {
      // Imported HTML, image syntax and URLs remain inert, editable text.
      children.push(new Paragraph({ text: line, widowControl: true }));
    }
  }
  const document = new Document({
    creator: "Rellane",
    lastModifiedBy: "Rellane",
    title,
    description: `Workroom output version ${version.revision}`,
    styles: {
      default: {
        document: {
          run: { font: "Arial", size: 22, color: "000000" },
          paragraph: { spacing: { after: 100, line: 276 } }
        },
        title: {
          run: { font: "Arial", size: 44, bold: true, color: "000000" },
          paragraph: { spacing: { after: 160 }, keepNext: true }
        },
        heading1: {
          run: { size: 30, bold: true, color: "000000" },
          paragraph: { spacing: { before: 240, after: 100 }, keepNext: true }
        },
        heading2: {
          run: { size: 26, bold: true, color: "000000" },
          paragraph: { spacing: { before: 200, after: 100 }, keepNext: true }
        },
        heading3: {
          run: { size: 24, bold: true, color: "000000" },
          paragraph: { spacing: { before: 160, after: 80 }, keepNext: true }
        }
      }
    },
    sections: [
      {
        properties: {
          page: {
            size: { width: 11906, height: 16838 },
            margin: { top: 1134, right: 1134, bottom: 1134, left: 1134 }
          }
        },
        children
      }
    ]
  });
  return Packer.toBuffer(document);
}
