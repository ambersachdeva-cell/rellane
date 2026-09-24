/**
 * Agents, flattened for the screen.
 *
 * The resolution and the prompt are both done here, in the main process, so
 * there is exactly one place that decides what an agent may do. A renderer that
 * applied the ceiling itself would be a second implementation of the most
 * security-relevant rule in the product, and it would be the one nobody tested.
 */

import type { AgentCard } from "@cadrane/contracts";
import { resolveBrief, type Ceiling } from "./brief.js";
import { toSystemPrompt } from "./context.js";
import { allAgents, SHIPPED_IDS } from "./roster.js";
import { TIER_LABELS } from "../subscription-brain/catalogue.js";

export function agentCards(ceiling: Ceiling): readonly AgentCard[] {
  return allAgents(ceiling.grantedFolders, ceiling.storedAgents).map((brief) => {
    const resolved = resolveBrief(brief, ceiling);
    return {
      id: brief.id,
      name: brief.name,
      purpose: brief.purpose,
      brief,
      sentence: resolved.sentence,
      tierLabel: TIER_LABELS[brief.engine.tier],
      outbound: brief.outbound,
      folders: resolved.folders,
      capabilities: resolved.capabilities,
      // The three that ship are not stored, so anything with a shipped id is
      // theirs and cannot be edited away.
      custom: !SHIPPED_IDS.includes(brief.id),
      withheld: resolved.withheld,
      inert: resolved.inert,
      systemPrompt: toSystemPrompt(resolved)
    };
  });
}
