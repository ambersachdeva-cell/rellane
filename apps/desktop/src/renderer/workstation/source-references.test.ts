import { expect, it } from "vitest";
import { splitSourceReferences } from "./source-references.js";
const first = "8cf2043f-fd6c-4236-9443-baee7bdf7f9c";
const second = "77172fbe-8572-448f-b385-59ecabdc5591";
it("resolves the actual local parenthesized source format and existing bracketed references", () => {
  expect(splitSourceReferences(`Green. (Source: ${first})`, [first])).toEqual(["Green. ", { ids: [first] }, ""]);
  expect(splitSourceReferences(`[${second.slice(0, 8)}, ${first}]`, [first, second])).toEqual(["", { ids: [second, first] }, ""]);
});
it("keeps unknown, ambiguous and mixed references as exact text", () => {
  for (const text of ["(Source: deadbeef)", `[${first}, deadbeef]`, "(Source: 8cf2043f)"])
    expect(splitSourceReferences(text, [first, "8cf2043f-aaaa-4236-9443-baee7bdf7f9c"]).filter(value => typeof value !== "string")).toEqual([]);
  const text = "(Source: deadbeef)";
  expect(splitSourceReferences(text, [first]).join("")).toBe(text);
});
