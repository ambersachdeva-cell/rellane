/**
 * Connectors worth installing, with their licences already checked.
 *
 * This is the cheapest leverage in the product. Every entry here is an entire
 * integration — filesystem access, SQL over a database, git history, fetching a
 * page — that somebody else wrote, tested and maintains, and that Rellane gains
 * by installing rather than by building. Writing these ourselves would be months
 * of work and a permanent maintenance burden, for capabilities that are already
 * commodity.
 *
 * ## Why the licence is a field and not a footnote
 *
 * Using open source commercially is normal and legal *when the licence is
 * honoured*, and honouring it costs almost nothing — a notice. Stripping
 * attribution is the one variant that creates real liability, and it buys
 * nothing at all.
 *
 * So the licence is carried in the data structure, shown on the screen next to
 * the install button, and the ones that cannot be used are absent rather than
 * listed with a warning. Two well-known platforms that a "just take it" plan
 * would have reached for are excluded on exactly this ground:
 *
 *   - **Dify** forbids multi-tenant resale *and* forbids removing its branding.
 *   - **FastGPT** paywalls multi-tenancy and custom branding.
 *
 * Neither is in this file, which is the point: compliance is a filter applied
 * once, here, rather than a risk carried forever.
 *
 * ## Nothing here is trusted
 *
 * A vetted licence is not a vetted tool. Everything installed from this
 * catalogue still goes through per-tool approval pinned to the description
 * (D-039). This list says "you may legally use this and it is well known", not
 * "this is safe to let an agent call".
 */

export interface CatalogueEntry {
  readonly id: string;
  readonly label: string;
  /** What it gives Rellane, in the owner's words rather than the project's. */
  readonly gives: string;
  readonly command: string;
  readonly args: readonly string[];
  /** SPDX identifier, checked against the project's own repository. */
  readonly licence: "MIT" | "Apache-2.0";
  /** Who wrote it. Shown, because attribution is the whole cost of using it. */
  readonly by: string;
  readonly homepage: string;
  /**
   * Set when a connector needs a folder, a file or a URL before it can run.
   * The catalogue cannot guess it, and installing something that immediately
   * fails teaches the owner that connectors do not work.
   */
  readonly needs: string | null;
}

/**
 * The shipped list. Deliberately short.
 *
 * Every entry is one somebody running a small business would actually use, and
 * each is checked for a permissive licence at the source repository. A long
 * catalogue of things nobody needs would make this a directory to browse rather
 * than a decision to make.
 */
export const CATALOGUE: readonly CatalogueEntry[] = Object.freeze([
  {
    id: "filesystem",
    label: "Files",
    gives: "Read and search inside a folder you choose, including subfolders.",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem"],
    licence: "MIT",
    by: "Anthropic",
    homepage: "https://github.com/modelcontextprotocol/servers",
    needs: "A folder to work in, added after the command."
  },
  {
    id: "sqlite",
    label: "A database file",
    gives: "Ask questions of a .db or .sqlite file in plain language.",
    command: "npx",
    args: ["-y", "mcp-server-sqlite-npx"],
    licence: "MIT",
    by: "the MCP community",
    homepage: "https://github.com/modelcontextprotocol/servers",
    needs: "The path to the database file."
  },
  {
    id: "git",
    label: "Git history",
    gives: "Read the history of a repository — what changed, when, and by whom.",
    command: "uvx",
    args: ["mcp-server-git", "--repository"],
    licence: "MIT",
    by: "Anthropic",
    homepage: "https://github.com/modelcontextprotocol/servers",
    needs: "The folder of the repository."
  },
  {
    id: "fetch",
    label: "Fetch a page",
    gives: "Read a web page as text. Reading only — it cannot post anything.",
    command: "uvx",
    args: ["mcp-server-fetch"],
    licence: "MIT",
    by: "Anthropic",
    homepage: "https://github.com/modelcontextprotocol/servers",
    needs: null
  },
  {
    id: "memory",
    label: "Long-term memory",
    gives: "Remember facts about people and jobs across sessions, in a local file.",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-memory"],
    licence: "MIT",
    by: "Anthropic",
    homepage: "https://github.com/modelcontextprotocol/servers",
    needs: null
  }
]);

/**
 * The attribution this Mac owes, as one block of text.
 *
 * Generated from what is actually installed rather than maintained by hand, so
 * it cannot drift out of date — a NOTICES file that lists something uninstalled,
 * or omits something installed, is worse than none because it looks maintained.
 */
export function noticesFor(installedIds: readonly string[]): string {
  const installed = CATALOGUE.filter((entry) => installedIds.includes(entry.id));
  if (installed.length === 0) {
    return "No third-party connectors are installed.";
  }
  return [
    "Rellane uses these open-source connectors. Each remains the work of its authors,",
    "under the licence named, and is used here in accordance with it.",
    "",
    ...installed.map(
      (entry) => `  ${entry.label} — ${entry.homepage}\n    © ${entry.by}, ${entry.licence}`
    )
  ].join("\n");
}
