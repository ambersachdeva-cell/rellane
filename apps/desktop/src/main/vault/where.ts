/**
 * Where the Vault lives.
 *
 * One function, because two places in the main process need the same folder and
 * a path spelled twice is a path that eventually differs — the handler that
 * writes it and the handler that opens it in Finder must agree, or the button
 * shows an empty folder and the owner concludes the feature does not work.
 *
 * It sits beside the book rather than inside a granted work folder: a vault in
 * Downloads would be tidied by the very agents this product ships.
 */

import { join } from "node:path";

export const VAULT_DIR_NAME = "Vault";

export function vaultFolder(userData: string): string {
  return join(userData, VAULT_DIR_NAME);
}
