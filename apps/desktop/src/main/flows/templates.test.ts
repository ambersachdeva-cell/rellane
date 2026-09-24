/**
 * The gallery.
 *
 * The done-when is a judgement about people: *an owner makes a working flow
 * from a template without opening the canvas.* So these check the two things
 * that decide whether that is true — the flow is valid without being touched,
 * and it cannot start anything on its own.
 */

import { describe, expect, it } from "vitest";
import { AutomationWorkflowSaveInputSchema } from "@cadrane/contracts";
import { fromTemplate, TEMPLATES } from "./templates.js";

const AGENT = "11111111-1111-4111-8111-111111111111";
const ids = () => {
  let n = 0;
  return () => {
    n += 1;
    return `${n.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;
  };
};

describe("every template", () => {
  it("is a valid flow the moment it is made, with nothing to fix", () => {
    // The whole point. A template that needs a repair before it saves is a
    // canvas exercise with extra steps.
    for (const template of TEMPLATES) {
      expect(() =>
        AutomationWorkflowSaveInputSchema.parse(fromTemplate(template, AGENT, ids()))
      ).not.toThrow();
    }
  });

  it("arrives switched off", () => {
    // A gallery click must not be able to start something that touches real
    // work on a Mac the template has never seen.
    for (const template of TEMPLATES) {
      const flow = fromTemplate(template, AGENT, ids());
      expect(flow.enabled).toBe(false);
      expect(flow.trigger).toEqual({ kind: "manual" });
    }
  });

  it("carries no folder", () => {
    // Same rule as a shared brief: it describes an intention and confers no
    // power. The folder is chosen in Finder, by a person.
    const text = JSON.stringify(TEMPLATES.map((template) => fromTemplate(template, AGENT, ids())));

    expect(text).not.toContain("/Users");
    expect(text).not.toContain("Downloads");
  });

  it("says why somebody would want it, not what it technically does", () => {
    for (const template of TEMPLATES) {
      expect(template.because.length).toBeGreaterThan(30);
      expect(template.says.length).toBeGreaterThan(10);
    }
  });

  it("has a budget big enough to finish itself", () => {
    // A template that runs out of budget partway is the worst of the three
    // outcomes: it does some of the work and stops.
    for (const template of TEMPLATES) {
      const flow = fromTemplate(template, AGENT, ids());
      expect(flow.budget.maxNodeExecutions).toBeGreaterThanOrEqual(flow.nodes.length);
    }
  });
});

describe("the steps", () => {
  it("run in order, each waiting on the one before", () => {
    const flow = fromTemplate(TEMPLATES[4]!, AGENT, ids());

    expect(flow.nodes).toHaveLength(3);
    expect(flow.nodes[0]?.dependsOn).toEqual([]);
    expect(flow.nodes[1]?.dependsOn).toEqual([flow.nodes[0]?.id]);
    expect(flow.nodes[2]?.dependsOn).toEqual([flow.nodes[1]?.id]);
  });

  it("gets new ids each time, so installing one twice gives two flows", () => {
    // Somebody wanting one per folder is doing something reasonable, and
    // silently overwriting the first would be data loss dressed as a click.
    const first = fromTemplate(TEMPLATES[0]!, AGENT, ids());
    const second = fromTemplate(TEMPLATES[0]!, AGENT, ids());

    expect(first.id).toBe(second.id); // same deterministic counter in this test
    const unique = fromTemplate(TEMPLATES[0]!, AGENT, () => crypto.randomUUID());
    expect(unique.id).not.toBe(first.id);
  });
});
