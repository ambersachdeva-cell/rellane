/**
 * The `switchboard://` scheme that serves the renderer.
 *
 * **The scheme keeps its old name deliberately, and must not be renamed.** It is
 * the *origin* the renderer runs under, so everything in `localStorage` is keyed
 * to it. Renaming it to `cadrane://` would leave every stored value behind on a
 * dead origin — invisibly, with the app looking like a normal first run. The
 * packages, the bridge global and the IPC channels were all renamed; this one
 * is load-bearing in a way a name usually is not.
 *
 * This is a security boundary: it turns a URL the renderer asked for into a
 * file on disk. Get it wrong and `switchboard://app/../../../../etc/passwd`
 * reads whatever the app process can read.
 *
 * The containment decision is therefore separated from the Electron wiring, so
 * it can be tested against real directories and real symlinks rather than
 * inspected and hoped about. `resolveAsset` is the whole boundary and needs no
 * Electron; `installApplicationProtocol` is four lines of plumbing around it.
 */

import path from "node:path";
import { realpath, stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { app, net, protocol } from "electron";

export const APPLICATION_URL = "switchboard://app/index.html";

export function registerApplicationScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: "switchboard",
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: false,
        allowServiceWorkers: false
      }
    }
  ]);
}

export type AssetVerdict =
  | { readonly ok: true; readonly file: string }
  | { readonly ok: false; readonly status: 400 | 403 | 404; readonly message: string };

/**
 * Which file, if any, a `switchboard://` URL is allowed to reach.
 *
 * Containment is checked twice, and both checks are load-bearing:
 *
 *   Before touching the disk, on the normalised path. This rejects the
 *   `../../../etc/passwd` family without a filesystem call, and rejects the
 *   URL shapes that have no business here at all — another hostname, embedded
 *   credentials, a port.
 *
 *   After resolving, on the *real* path. A symlink inside the renderer folder
 *   pointing at the home directory passes the first check comfortably, because
 *   textually it never leaves the root. Only realpath sees through it.
 *
 * Directories are refused rather than served as an index, and anything that is
 * not a regular file — a fifo, a device, a socket — is refused with it.
 */
export async function resolveAsset(
  rawUrl: string,
  root: string,
  realRoot?: string
): Promise<AssetVerdict> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, status: 400, message: "Bad request" };
  }

  if (url.hostname !== "app" || url.username !== "" || url.password !== "" || url.port !== "") {
    return { ok: false, status: 404, message: "Not found" };
  }

  let decodedPath: string;
  try {
    // Percent-decoding is where `%2e%2e%2f` becomes `../`, so the traversal
    // checks below must run on the decoded form, never on the raw one.
    decodedPath = decodeURIComponent(url.pathname);
  } catch {
    return { ok: false, status: 400, message: "Bad request" };
  }

  const requestedAsset = decodedPath === "/" ? "index.html" : decodedPath.slice(1);
  const normalizedAsset = path.normalize(requestedAsset);
  const resolvedAsset = path.resolve(root, normalizedAsset);
  const relativeAsset = path.relative(root, resolvedAsset);
  if (
    relativeAsset.startsWith("..") ||
    path.isAbsolute(relativeAsset) ||
    normalizedAsset.includes("\0")
  ) {
    return { ok: false, status: 403, message: "Forbidden" };
  }

  try {
    const [resolvedRoot, realAsset, assetStat] = await Promise.all([
      realRoot === undefined ? realpath(root) : Promise.resolve(realRoot),
      realpath(resolvedAsset),
      stat(resolvedAsset)
    ]);
    const realRelativeAsset = path.relative(resolvedRoot, realAsset);
    if (
      realRelativeAsset.startsWith("..") ||
      path.isAbsolute(realRelativeAsset) ||
      !assetStat.isFile()
    ) {
      return { ok: false, status: 403, message: "Forbidden" };
    }
    return { ok: true, file: realAsset };
  } catch {
    return { ok: false, status: 404, message: "Not found" };
  }
}

export function installApplicationProtocol(): void {
  const rendererRoot = path.join(app.getAppPath(), "dist", "renderer");
  // Resolved once at install rather than per request: it cannot change while
  // the app runs, and it is the same answer every time.
  const rendererRootRealPath = realpath(rendererRoot);

  protocol.handle("switchboard", async (request) => {
    const verdict = await resolveAsset(request.url, rendererRoot, await rendererRootRealPath);
    if (!verdict.ok) {
      return new Response(verdict.message, { status: verdict.status });
    }
    return net.fetch(pathToFileURL(verdict.file).toString());
  });
}
