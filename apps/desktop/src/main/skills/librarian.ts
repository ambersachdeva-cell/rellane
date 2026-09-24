/**
 * Desktop Librarian — proposes where things should go, and moves nothing until
 * you agree.
 *
 * The filing decision is deterministic here rather than delegated to a model.
 * A model is genuinely better at "what is this document about", and that is
 * where it will be used — reading a PDF to tell an invoice from a dieline. But
 * "a .pdf whose text says 'Tax Invoice' belongs in Invoices" is a rule, and a
 * rule that runs in a millisecond and never varies beats a rule that costs
 * fourteen seconds and sometimes does.
 *
 * The plan is the product. Anyone can move files; the reason to trust this is
 * that you can read what it intends to do first.
 */

import { basename, extname, join } from "node:path";
import { newPlan, type Plan } from "../tools/receipt.js";
import { plural } from "../../shared/copy.js";

export interface FileEntry {
  readonly name: string;
  readonly path: string;
  readonly kind: "file" | "folder";
  readonly extension: string;
  readonly bytes: number;
  readonly modified: string;
}

export interface Category {
  readonly id: string;
  /** Folder name as a person would write it. */
  readonly folder: string;
  readonly extensions: readonly string[];
}

/**
 * Categories are broad on purpose. A taxonomy with thirty folders is one nobody
 * maintains; eight that match how people already think about their files is one
 * they keep.
 *
 * The extension lists are wide rather than narrow — a real Downloads folder is
 * full of formats a short list misses, and a file the Librarian cannot place is
 * a file it leaves behind. Generated mechanically and checked for malformed
 * entries and for any extension claimed by two categories, which is the only
 * way this table can be wrong.
 */
export const CATEGORIES: readonly Category[] = Object.freeze([
  {
    id: "documents",
    folder: "Documents",
    extensions: [
      ".azw3", ".djvu", ".doc", ".docx", ".dot", ".dotx", ".epub", ".fb2", ".key",
      ".mobi", ".odp", ".odt", ".oxps", ".pages", ".pdf", ".pot", ".potx", ".pps",
      ".ppsx", ".ppt", ".pptx", ".rtf", ".txt", ".xps"
    ]
  },
  {
    id: "sheets",
    folder: "Spreadsheets",
    extensions: [
      ".arrow", ".csv", ".dbf", ".dif", ".dta", ".feather", ".numbers", ".ods",
      ".parquet", ".prn", ".sas7bdat", ".sav", ".slk", ".tsv", ".xls", ".xlsb", ".xlsm",
      ".xlsx", ".xltm", ".xltx"
    ]
  },
  {
    id: "images",
    folder: "Images",
    extensions: [
      ".arw", ".avif", ".bmp", ".cr2", ".cr3", ".dng", ".gif", ".heic", ".heif", ".ico",
      ".jfif", ".jpeg", ".jpg", ".nef", ".pjp", ".pjpeg", ".png", ".raw", ".svg",
      ".tif", ".tiff", ".webp"
    ]
  },
  {
    id: "artwork",
    folder: "Artwork",
    extensions: [
      ".afdesign", ".afphoto", ".afpub", ".ai", ".blend", ".c4d", ".cdr", ".dwg",
      ".dxf", ".eps", ".fbx", ".fig", ".idml", ".iges", ".igs", ".indd", ".kra", ".ma",
      ".max", ".mb", ".obj", ".psb", ".psd", ".sketch", ".step", ".stl", ".stp", ".xd"
    ]
  },
  {
    id: "archives",
    folder: "Archives",
    extensions: [
      ".7z", ".bz2", ".cab", ".cpio", ".dmg", ".gz", ".img", ".iso", ".lz", ".lzh",
      ".lzma", ".qcow2", ".rar", ".tar", ".tbz2", ".tgz", ".txz", ".vhd", ".vhdx",
      ".vmdk", ".wim", ".xz", ".z", ".zip"
    ]
  },
  {
    id: "media",
    folder: "Media",
    extensions: [
      ".3gp", ".aac", ".aiff", ".alac", ".avi", ".flac", ".flv", ".m2ts", ".m4a",
      ".m4b", ".m4v", ".mid", ".midi", ".mkv", ".mov", ".mp3", ".mp4", ".ogg", ".ogv",
      ".opus", ".vob", ".wav", ".webm", ".wma", ".wmv"
    ]
  },
  {
    id: "code",
    folder: "Code",
    extensions: [
      ".bash", ".c", ".cpp", ".cs", ".css", ".env", ".go", ".h", ".hpp", ".html",
      ".ipynb", ".java", ".js", ".json", ".jsx", ".kt", ".md", ".php", ".py", ".rb",
      ".rs", ".scss", ".sh", ".sql", ".swift", ".toml", ".ts", ".tsx", ".xml", ".yaml",
      ".yml", ".zsh"
    ]
  },
  {
    id: "installers",
    folder: "Installers",
    extensions: [
      ".apk", ".apkm", ".appimage", ".appx", ".appxbundle", ".crx", ".deb", ".exe",
      ".flatpak", ".ipa", ".msi", ".msix", ".msixbundle", ".msp", ".msu", ".pkg",
      ".rpm", ".snap", ".xapk", ".xpi"
    ]
  }
]);

export function categoryFor(extension: string): Category | null {
  const normalised = extension.toLowerCase();
  return CATEGORIES.find((category) => category.extensions.includes(normalised)) ?? null;
}

export interface Proposal {
  readonly file: FileEntry;
  readonly category: Category;
  readonly destination: string;
}

export interface Survey {
  readonly proposals: readonly Proposal[];
  /** Files deliberately left alone, with the reason. Never silently skipped. */
  readonly untouched: readonly { file: FileEntry; reason: string }[];
}

export interface SurveyOptions {
  /** Folders already organised are left alone rather than nested deeper. */
  readonly knownFolders?: readonly string[] | undefined;
  /** Files newer than this are probably still in use. */
  readonly minimumAgeMs?: number | undefined;
  readonly now?: number | undefined;
}

const DEFAULT_MIN_AGE_MS = 60 * 60_000;

/**
 * Decides what should move where.
 *
 * Pure: no filesystem, no clock of its own. The caller supplies the listing,
 * which makes every decision here reproducible and testable.
 */
export function survey(
  root: string,
  files: readonly FileEntry[],
  options: SurveyOptions = {}
): Survey {
  const now = options.now ?? Date.now();
  const minimumAge = options.minimumAgeMs ?? DEFAULT_MIN_AGE_MS;
  const known = new Set((options.knownFolders ?? CATEGORIES.map((c) => c.folder)).map((f) => f.toLowerCase()));

  const proposals: Proposal[] = [];
  const untouched: { file: FileEntry; reason: string }[] = [];

  for (const file of files) {
    if (file.kind === "folder") {
      untouched.push({
        file,
        reason: known.has(file.name.toLowerCase())
          ? "Already one of the folders things get filed into."
          : "Folders are left alone; only loose files are filed."
      });
      continue;
    }

    // Something saved in the last hour is very likely still being worked on.
    const age = now - Date.parse(file.modified);
    if (Number.isFinite(age) && age < minimumAge) {
      untouched.push({ file, reason: "Saved in the last hour, so it is probably still in use." });
      continue;
    }

    const category = categoryFor(file.extension === "" ? extname(file.name) : file.extension);
    if (category === null) {
      untouched.push({
        file,
        reason:
          file.extension === ""
            ? "No file extension, so there is nothing to go on yet."
            : `Nothing is filed by ${file.extension} yet.`
      });
      continue;
    }

    proposals.push({ file, category, destination: join(root, category.folder) });
  }

  return { proposals, untouched };
}

/** Turns a survey into a plan the executor can run. */
export function planFrom(survey: Survey, root: string, now: number): Plan {
  return newPlan({
    skill: "librarian",
    intent: `Tidy ${basename(root)}`,
    now,
    steps: survey.proposals.map((proposal) => ({
      tool: "move_file",
      risk: "write" as const,
      summary: `${proposal.file.name} → ${proposal.category.folder}/`,
      args: { from: proposal.file.path, toFolder: proposal.destination },
      decision: "run" as const,
      reason: `A ${proposal.file.extension} file belongs in ${proposal.category.folder}.`
    }))
  });
}

/** One sentence for the approval sheet, before anything has happened. */
export function describeSurvey(survey: Survey): string {
  if (survey.proposals.length === 0) {
    return survey.untouched.length === 0
      ? "That folder is empty."
      : survey.untouched.length === 1
        // The pronoun has to agree too. "all 1 item is already where they
        // should be" is worse than the bug it replaced.
        ? "Nothing to file — the one item here is already where it should be."
        : `Nothing to file — all ${survey.untouched.length} items are already where they should be.`;
  }
  const folders = new Set(survey.proposals.map((p) => p.category.folder));
  const left =
    survey.untouched.length === 0 ? "" : `, leaving ${survey.untouched.length} alone`;
  return `Move ${plural(survey.proposals.length, "file")} into ${plural(folders.size, "folder")}${left}.`;
}
