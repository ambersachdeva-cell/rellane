export interface PackItem {
  readonly relativePath: string;
  readonly kind: "output" | "source" | "image" | "record";
  readonly title: string;
  readonly bytes: number;
  readonly sourceId: string | null;
}

export interface PackPlan {
  readonly folderName: string;
  readonly items: readonly PackItem[];
  readonly totalBytes: number;
  readonly readme: string;
  readonly excluded: readonly { readonly title: string; readonly reason: string }[];
  readonly warnings: readonly string[];
}

export const MAX_PACK_BYTES = 209_715_200;

export interface PackInput {
  readonly workTitle: string;
  readonly clientName: string | null;
  readonly at: number;
  readonly outputs: readonly {
    readonly id: string;
    readonly title: string;
    readonly body: string;
    readonly revision: number;
  }[];
  readonly sources: readonly {
    readonly id: string;
    readonly label: string;
    readonly bytes: number;
    readonly internal: boolean;
  }[];
  readonly images: readonly {
    readonly id: string;
    readonly label: string;
    readonly bytes: number;
  }[];
  readonly recordMarkdown: string;
}

/**
 * Dates format to standard ISO calendar days so client folders sort predictably.
 */
function formatDate(at: number): string {
  if (!Number.isFinite(at)) {
    return "";
  }
  const date = new Date(at);
  if (isNaN(date.getTime())) {
    return "";
  }
  return date.toISOString().slice(0, 10);
}

/**
 * Sanitise a title or folder name to letters, digits, spaces, and hyphens.
 * Slashes, dots, and shell characters are stripped so the folder and files
 * remain safe across macOS filesystems and Finder.
 */
function sanitiseName(raw: string, fallback: string): string {
  const withoutSeparators = raw.replace(/[/\\]/g, " ");
  const allowedOnly = withoutSeparators.replace(/[^a-zA-Z0-9 -]/g, " ");
  const collapsedSpaces = allowedOnly.replace(/\s+/g, " ");
  const collapsedHyphens = collapsedSpaces.replace(/-+/g, "-");
  let cleaned = collapsedHyphens
    .replace(/^[ -]+|[ -]+$/g, "")
    .replace(/^\.+/, "")
    .trim();

  if (cleaned.length > 80) {
    cleaned = cleaned.slice(0, 80).trim().replace(/-+$/, "");
  }

  if (cleaned.length === 0 || cleaned.startsWith(".")) {
    return fallback;
  }
  return cleaned;
}

/**
 * Allocates unique relative paths within the pack folder.
 * APFS is case-insensitive by default, so uniqueness checks are case-insensitive
 * to prevent accidental file overwrites on disk.
 */
class PathAllocator {
  private readonly used = new Set<string>();

  allocate(title: string, fallback: string): string {
    const base = sanitiseName(title, fallback);
    let candidate = base;
    let suffix = 2;

    while (this.used.has(candidate.toLowerCase())) {
      const suffixStr = `-${suffix}`;
      const maxBaseLen = Math.max(1, 80 - suffixStr.length);
      const truncatedBase = base.slice(0, maxBaseLen).replace(/-+$/, "");
      candidate = `${truncatedBase}${suffixStr}`;
      suffix++;
    }

    this.used.add(candidate.toLowerCase());
    return candidate;
  }
}

/**
 * Generates a calm, plain-English index document for the client without tooling jargon.
 */
function generateReadme(
  workTitle: string,
  clientName: string | null,
  dateStr: string,
  items: readonly PackItem[]
): string {
  const lines: string[] = [];

  const heading = clientName
    ? `${clientName} - ${workTitle || "Delivery Pack"}`
    : workTitle || "Delivery Pack";
  lines.push(`# ${heading}`);
  lines.push("");
  if (dateStr.length > 0) {
    lines.push(`Date: ${dateStr}`);
    lines.push("");
  }
  lines.push(
    "This folder contains the deliverables and supporting materials prepared for you."
  );
  lines.push("");

  const outputs = items.filter((item) => item.kind === "output");
  const sources = items.filter((item) => item.kind === "source");
  const images = items.filter((item) => item.kind === "image");
  const records = items.filter((item) => item.kind === "record");

  if (outputs.length > 0) {
    lines.push("## Documents");
    lines.push("");
    for (const item of outputs) {
      lines.push(`- ${item.relativePath} (${item.title})`);
    }
    lines.push("");
  }

  if (sources.length > 0) {
    lines.push("## Sources");
    lines.push("");
    for (const item of sources) {
      lines.push(`- ${item.relativePath} (${item.title})`);
    }
    lines.push("");
  }

  if (images.length > 0) {
    lines.push("## Images");
    lines.push("");
    for (const item of images) {
      lines.push(`- ${item.relativePath} (${item.title})`);
    }
    lines.push("");
  }

  if (records.length > 0) {
    lines.push("## Record of Work");
    lines.push("");
    for (const item of records) {
      lines.push(`- ${item.relativePath}: a summary of the work that was completed`);
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd() + "\n";
}

export function planDeliveryPack(input: PackInput): PackPlan {
  const dateStr = formatDate(input.at);
  const folderParts: string[] = [];
  if (input.clientName && input.clientName.trim().length > 0) {
    folderParts.push(input.clientName.trim());
  }
  if (input.workTitle && input.workTitle.trim().length > 0) {
    folderParts.push(input.workTitle.trim());
  }
  if (dateStr.length > 0) {
    folderParts.push(dateStr);
  }

  const rawFolderName = folderParts.join(" - ");
  const folderName = sanitiseName(rawFolderName, "delivery-pack");

  const items: PackItem[] = [];
  const excluded: { readonly title: string; readonly reason: string }[] = [];
  const pathAllocator = new PathAllocator();
  const encoder = new TextEncoder();

  // Deduplicate outputs: only the latest revision of each document goes into the client pack.
  type OutputItem = PackInput["outputs"][number];
  const groupsById = new Map<string, OutputItem[]>();
  for (const output of input.outputs) {
    const list = groupsById.get(output.id);
    if (list) {
      list.push(output);
    } else {
      groupsById.set(output.id, [output]);
    }
  }

  const candidateGroups: OutputItem[][] = [];
  for (const group of groupsById.values()) {
    candidateGroups.push(group);
  }

  // Merge cross-id groups that share title and revision sequences to prevent older drafts leaking.
  const resolvedGroups: OutputItem[][] = [];
  for (const group of candidateGroups) {
    const rep = group[0];
    if (!rep) {
      continue;
    }
    const matchIdx = resolvedGroups.findIndex((existing) => {
      const existingRep = existing[0];
      if (!existingRep) {
        return false;
      }
      if (existingRep.title === rep.title) {
        const existingRevs = new Set(existing.map((o) => o.revision));
        return !group.some((o) => existingRevs.has(o.revision));
      }
      return false;
    });

    if (matchIdx >= 0 && matchIdx < resolvedGroups.length) {
      resolvedGroups[matchIdx]!.push(...group);
    } else {
      resolvedGroups.push([...group]);
    }
  }

  for (const group of resolvedGroups) {
    let maxRev = -Infinity;
    for (const out of group) {
      if (out.revision > maxRev) {
        maxRev = out.revision;
      }
    }

    for (const out of group) {
      if (out.revision < maxRev) {
        excluded.push({
          title: out.title,
          reason: "Superseded by a newer revision."
        });
      } else {
        const relativePath = pathAllocator.allocate(out.title, "document");
        items.push({
          relativePath,
          kind: "output",
          title: out.title,
          bytes: encoder.encode(out.body).byteLength,
          sourceId: null
        });
      }
    }
  }

  // Internal sources are strictly omitted to protect client confidentiality.
  for (const source of input.sources) {
    if (source.internal) {
      excluded.push({
        title: source.label,
        reason: "Internal source not included in client pack."
      });
    } else {
      const relativePath = pathAllocator.allocate(source.label, "source");
      items.push({
        relativePath,
        kind: "source",
        title: source.label,
        bytes: Math.max(0, source.bytes),
        sourceId: source.id
      });
    }
  }

  // Image assets referenced by the work.
  for (const image of input.images) {
    const relativePath = pathAllocator.allocate(image.label, "image");
    items.push({
      relativePath,
      kind: "image",
      title: image.label,
      bytes: Math.max(0, image.bytes),
      sourceId: null
    });
  }

  // The record markdown explains what was done.
  const recordBytes = encoder.encode(input.recordMarkdown).byteLength;
  const recordPath = pathAllocator.allocate("Record", "record");
  items.push({
    relativePath: recordPath,
    kind: "record",
    title: "Record",
    bytes: recordBytes,
    sourceId: null
  });

  const totalBytes = items.reduce((sum, item) => sum + item.bytes, 0);

  const warnings: string[] = [];
  if (totalBytes > MAX_PACK_BYTES) {
    warnings.push("The pack exceeds the maximum recommended size of 200 MB.");
  }
  if (!items.some((item) => item.kind === "output")) {
    warnings.push("No outputs are included in this pack.");
  }
  if (input.sources.length > 0 && !items.some((item) => item.kind === "source")) {
    warnings.push("Every source was marked internal and excluded from this pack.");
  }

  const readme = generateReadme(input.workTitle, input.clientName, dateStr, items);

  return {
    folderName,
    items,
    totalBytes,
    readme,
    excluded,
    warnings
  };
}
