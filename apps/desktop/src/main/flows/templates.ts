/**
 * Flows somebody can start from, without opening the canvas.
 *
 * The done-when is precise and it is a judgement about people, not about
 * software: *an owner makes a working flow from a template without opening the
 * canvas.* A canvas is a wonderful thing to have and a terrible thing to
 * require — anybody who has to arrange boxes before getting a first result will
 * decide the feature is not for them, and they will be right.
 *
 * ## Why these five
 *
 * Each is a job Amber's businesses actually do, written from the work rather
 * than from what the runtime can express. A gallery of things the engine
 * happens to support is a feature list; a gallery of things somebody was going
 * to do anyway is a product.
 *
 * ## Every template arrives switched off
 *
 * `enabled: false`, always, and there is no field to change that here. A
 * template is a starting point that has never seen this Mac: it does not know
 * which folder, which customers, or how often that folder moves. Arriving armed
 * would mean a gallery click can start something touching real work — and the
 * one that watches a folder would begin before anybody had run the backtest
 * that tells them how often that folder actually changes (D-077).
 *
 * ## They carry no folder
 *
 * Same rule as a shared brief (D-075): a template describes an intention and
 * confers no power. The folder is chosen on this Mac, in Finder, by a person.
 */

import type { AutomationNode, AutomationWorkflowSaveInput } from "@cadrane/contracts";

export interface FlowTemplate {
  readonly id: string;
  readonly name: string;
  /** What it does for you, in the words somebody would use for the job. */
  readonly says: string;
  /** Why you would want it, one sentence. Shown under the name. */
  readonly because: string;
  /** True when it needs a folder before it can be armed. */
  readonly needsFolder: boolean;
  readonly steps: readonly { readonly title: string; readonly instruction: string }[];
}

export const TEMPLATES: readonly FlowTemplate[] = [
  {
    id: "bills-that-landed",
    name: "Bills that landed",
    says: "Read whatever arrived and tell me which are bills",
    because:
      "Entering a day's bills by hand is the tax this product charges for being useful, and it is the reason a trader goes back to paper.",
    needsFolder: true,
    steps: [
      {
        title: "Look at what is new",
        instruction:
          "List what has arrived in the folder since you last looked. Say what each file appears to be. Do not open anything you were not asked to."
      },
      {
        title: "Pick out the bills",
        instruction:
          "From that list, name the ones that look like invoices or bills. For each, say who it appears to be from and why you think so. If you are not sure, say you are not sure — a maybe is more useful than a confident wrong answer."
      }
    ]
  },
  {
    id: "who-owes-me",
    name: "Who owes me",
    says: "Go through the book and tell me who is late",
    because: "The question every morning starts with, and the one a ledger answers badly.",
    needsFolder: false,
    steps: [
      {
        title: "Read the book",
        instruction:
          "List every customer with money outstanding, oldest bill first. Give the amount and how many days late. Use only what the book says."
      },
      {
        title: "Say who to chase first",
        instruction:
          "Of those, say which three are worth a call today and why — size, age, or how long they usually take. Do not draft a message; that is a separate step somebody approves."
      }
    ]
  },
  {
    id: "what-changed",
    name: "What changed while I was out",
    says: "Tell me what moved in a folder, in plain words",
    because: "A folder you share with other people is one you stop trusting when you cannot see it.",
    needsFolder: true,
    steps: [
      {
        title: "Compare it with before",
        instruction:
          "Say what is new, what has gone, and what has changed since the last time you looked. Group them so it reads as a short account rather than a list of paths."
      }
    ]
  },
  {
    id: "tidy-the-quotes",
    name: "Tidy the quotes",
    says: "Sort loose documents into a folder for each customer",
    because: "The job that is never urgent enough to do and never small enough to enjoy.",
    needsFolder: true,
    steps: [
      {
        title: "Work out where each one belongs",
        instruction:
          "For each loose document, say which customer it belongs to and what you would name it. Match against the names in the book rather than inventing new ones. Say which you could not place, and why."
      },
      {
        title: "Propose the moves",
        instruction:
          "Write the plan as a list of moves. Change nothing — every move is shown to the owner before it happens, and they approve the plan as a whole."
      }
    ]
  },
  {
    id: "end-of-month",
    name: "End of the month",
    says: "Put together what my accountant will ask for",
    because: "It is the same list every month, and assembling it is an evening.",
    needsFolder: false,
    steps: [
      {
        title: "Total the month",
        instruction:
          "From the book, give the month's totals: billed, received, and still outstanding. Break the outstanding down by customer."
      },
      {
        title: "Find what is missing",
        instruction:
          "Name any bill without a document attached, and any payment that is not allocated to a bill. These are the things that get queried, and finding them now is cheaper than finding them in April."
      },
      {
        title: "Write it up",
        instruction:
          "Write the above as a short note somebody could forward without editing. Plain sentences, no headings, amounts in rupees."
      }
    ]
  }
];

/**
 * Turns a template into a flow, ready to be saved.
 *
 * Ids are made here rather than carried, so installing the same template twice
 * gives two flows rather than silently overwriting the first — somebody who
 * wants one per folder is doing something reasonable.
 */
export function fromTemplate(
  template: FlowTemplate,
  agentId: string,
  ids: () => string
): AutomationWorkflowSaveInput {
  // Ids first, because each step depends on the one before it and a node
  // cannot reference an id that has not been made yet. Written as a chain
  // rather than a fan-out: these are accounts of work, and the second paragraph
  // only makes sense once the first exists.
  const stepIds = template.steps.map(() => ids());
  const nodes: AutomationNode[] = template.steps.map((step, index) => ({
    id: stepIds[index] ?? ids(),
    title: step.title,
    instruction: step.instruction,
    kind: "model",
    agentId,
    connectorId: null,
    dependsOn: index === 0 ? [] : [stepIds[index - 1] ?? ""].filter(Boolean)
  }));

  return {
    id: ids(),
    name: template.name,
    description: template.says,
    // Off. Always. There is no parameter here that can arm a template, because
    // a gallery click must not be able to start something that touches real
    // work on a Mac the template has never seen.
    enabled: false,
    trigger: { kind: "manual" },
    budget: {
      maxDurationMs: 300_000,
      maxNodeExecutions: Math.max(4, template.steps.length * 2),
      maxOutputCharacters: 40_000
    },
    nodes
  };
}
