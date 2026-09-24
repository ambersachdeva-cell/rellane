/**
 * The agents that ship with Rellane.
 *
 * Three, not thirty. An empty agents screen teaches nothing and a crowded one
 * teaches the wrong thing — that agents are a menu you pick from rather than a
 * brief you write. These exist to show the *range* of what a brief can say:
 * one that proposes filing, one that only reads, and one that prepares something
 * to send but cannot send it.
 *
 * Each is deliberately narrow. A shipped agent with broad permissions is a bad
 * example that every agent a person writes afterwards will copy.
 */

import type { AgentBrief } from "@cadrane/contracts";
import { newBrief } from "./brief.js";

/**
 * Builds the shipped briefs against the folders actually granted.
 *
 * They are generated rather than stored so that a default never references a
 * folder this Mac does not have — which would put a withheld-permission warning
 * on a fresh install and teach the owner that warnings are decoration.
 */
export function builtInAgents(grantedFolders: readonly string[]): readonly AgentBrief[] {
  const first = grantedFolders[0];
  const folders = first === undefined ? [] : [first];

  return [
    newBrief({
      id: "filing-clerk",
      name: "Filing clerk",
      purpose: "Review a folder and propose a filing plan you can check",
      instructions: [
        "Propose a plan only. You cannot move, rename or change files. Never say that you did.",
        "Prefer the client's name over the date when both would work as a folder.",
        "Never invent a category for a single file. If one file does not fit, leave it where it is and say so."
      ].join("\n"),
      folders,
      reads: ["folders", "glossary"],
      // Tool names, not skill names. A brief that named "librarian" was
      // naming something the tool registry has never heard of.
      capabilities: ["list_folder", "read_text"],
      tier: "on-device",
      maxSteps: 8,
      maxMinutes: 3,
      // Reading and proposing are local. There is no write or send step.
      outbound: "never"
    }),

    newBrief({
      id: "what-changed",
      name: "What changed",
      purpose: "Review a folder, with gaps in its change history made explicit",
      instructions:
        "Use before-and-after evidence for change claims. If none is supplied, say that change history is unavailable and describe only the current listing. A modification date cannot prove when a file arrived, moved, or who changed it.",
      folders,
      reads: ["folders", "timeline"],
      // Reads only. The narrowest useful agent, and the one to point at when
      // somebody asks what an agent can do without any risk at all.
      capabilities: ["list_folder"],
      tier: "on-device",
      maxSteps: 12,
      maxMinutes: 3,
      outbound: "never"
    }),

    newBrief({
      id: "drafts",
      name: "Drafts",
      purpose: "Turn something you paste into the message you meant to write",
      instructions: [
        "Match the owner's own voice from what they have written before, not a business-letter register.",
        "Hindi and Hinglish are normal. Do not translate someone into English they would not use."
      ].join("\n"),
      folders,
      reads: ["glossary", "vault"],
      capabilities: ["read_text"],
      // This route has no approved provider dispatch. Draft locally and review.
      tier: "on-device",
      maxSteps: 8,
      maxMinutes: 3,
      // The one that prepares something to send, and still cannot send it.
      outbound: "ask"
    })
  ];
}
