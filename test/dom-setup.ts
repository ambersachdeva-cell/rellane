/**
 * What every component test in this repo gets for free.
 *
 * Three things, and each is here because its absence fails in a way that reads
 * like a component bug:
 *
 * 1. The matchers. `expect(button).toBeDisabled()` reads as the sentence the
 *    test is making; `expect(button.hasAttribute("disabled")).toBe(true)` reads
 *    as its mechanism.
 * 2. Cleanup between tests. Testing Library only registers this itself when
 *    vitest runs with globals on, and this repo imports `describe`/`it`
 *    explicitly instead. Without it every render stays in the document and the
 *    second test to look for a heading finds two of them.
 * 3. `<dialog>`. jsdom parses the element but implements neither `showModal`
 *    nor `close`, and this app's one `Modal` calls both — so any test of any
 *    screen built on it died inside an effect, pointing at `ui.tsx` rather than
 *    at the missing browser feature. This is the smallest honest stand-in: it
 *    tracks `open` the way the real thing does and does nothing else. A test
 *    that needs real modal behaviour — focus trapping, the top layer, Escape —
 *    is a test jsdom cannot answer, and should be walked in the app instead.
 */
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";

type DialogLike = HTMLDialogElement & { __open?: boolean };

if (typeof HTMLDialogElement !== "undefined" && HTMLDialogElement.prototype.showModal === undefined) {
  HTMLDialogElement.prototype.showModal = function showModal(this: DialogLike): void {
    this.setAttribute("open", "");
    this.__open = true;
  };
  HTMLDialogElement.prototype.show = function show(this: DialogLike): void {
    this.setAttribute("open", "");
    this.__open = true;
  };
  HTMLDialogElement.prototype.close = function close(this: DialogLike, returnValue?: string): void {
    this.removeAttribute("open");
    this.__open = false;
    if (returnValue !== undefined) this.returnValue = returnValue;
    this.dispatchEvent(new Event("close"));
  };
}

afterEach(() => {
  cleanup();
});
