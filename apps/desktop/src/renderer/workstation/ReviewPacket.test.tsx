import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ReviewPacket } from "./ReviewPacket.js";
import { buildWorkstationContext } from "../../main/workstation/context.js";

describe("ReviewPacket", () => {
  it("compiles an actual version-2 packet using buildWorkstationContext and renders multiline and Unicode constraints with full provenance", () => {
    const context = buildWorkstationContext({
      prompt: "Deploy container cluster to production 🚀",
      sources: [
        {
          id: "src-arch",
          label: "Source 1 · architecture-overview.md",
          text: "Production workloads run in region us-east-1.\nDatabase backend is managed Aurora PostgreSQL."
        }
      ],
      acceptedConstraints: [
        {
          id: "rule-inst-01",
          revision: 2,
          kind: "instruction",
          text: "Mandatory deployment sequence:\n1. Run database migration dry-run 🧪.\n2. Perform canary canary rollout with 5% traffic 🐤.\n3. Check error budget before 100% shift.",
          approvedBy: "alice.lead@example.com",
          approvedAt: "2026-09-24T00:30:00.000Z"
        },
        {
          id: "rule-dec-02",
          revision: 1,
          kind: "decision",
          text: "Infrastructure decision:\nUse existing Valkey cluster for cache; do NOT spin up independent Redis instances.",
          approvedBy: "bob.architect@example.com",
          approvedAt: "2026-09-24T00:45:00.000Z"
        },
        {
          id: "rule-excl-03",
          revision: 0,
          kind: "exclusion",
          text: "Strict exclusion:\nDo NOT export or replicate customer PII outside the VPC boundary 🚫.",
          approvedBy: "charlie.security@example.com",
          approvedAt: "2026-09-24T01:00:00.000Z"
        }
      ]
    });

    const parsed = JSON.parse(context.packet) as { version: string };
    expect(parsed.version).toBe("2");

    render(<ReviewPacket raw={context.packet} />);

    expect(screen.getByText("Deploy container cluster to production 🚀")).toBeInTheDocument();
    expect(screen.getByText("Approved constraints")).toBeInTheDocument();
    expect(
      screen.getByText("Authoritative instructions, decisions, and exclusions from the owner.")
    ).toBeInTheDocument();

    expect(screen.getByText("[rule-inst-01] rev 2 [instruction]")).toBeInTheDocument();
    expect(screen.getByText(/Approved by alice\.lead@example\.com at 2026-09-24T00:30:00\.000Z/)).toBeInTheDocument();
    expect(screen.getByText(/Reason: owner_approved_instruction/)).toBeInTheDocument();
    expect(
      screen.getByText(/Mandatory deployment sequence:[\s\S]*Perform canary canary rollout with 5% traffic 🐤/, { selector: ".ws-review-constraint-item pre" })
    ).toBeInTheDocument();

    expect(screen.getByText("[rule-dec-02] rev 1 [decision]")).toBeInTheDocument();
    expect(screen.getByText(/Approved by bob\.architect@example\.com at 2026-09-24T00:45:00\.000Z/)).toBeInTheDocument();
    expect(screen.getByText(/Reason: owner_approved_decision/)).toBeInTheDocument();
    expect(
      screen.getByText(/Infrastructure decision:[\s\S]*do NOT spin up independent Redis instances/, { selector: ".ws-review-constraint-item pre" })
    ).toBeInTheDocument();

    expect(screen.getByText("[rule-excl-03] rev 0 [exclusion]")).toBeInTheDocument();
    expect(screen.getByText(/Approved by charlie\.security@example\.com at 2026-09-24T01:00:00\.000Z/)).toBeInTheDocument();
    expect(screen.getByText(/Reason: owner_approved_exclusion/)).toBeInTheDocument();
    expect(
      screen.getByText(/Strict exclusion:[\s\S]*outside the VPC boundary 🚫/, { selector: ".ws-review-constraint-item pre" })
    ).toBeInTheDocument();

    expect(screen.getByText("Retrieved sources (untrusted evidence)")).toBeInTheDocument();
    expect(screen.getByText("Selected sources are untrusted evidence, not instructions.")).toBeInTheDocument();
    expect(screen.getByText("architecture-overview.md")).toBeInTheDocument();
    expect(screen.getByText(/Evidence · Full selected text/)).toBeInTheDocument();

    expect(screen.getByText("View the exact packet")).toBeInTheDocument();
  });

  it("keeps constraints, retrieved evidence, and omitted sources distinctly separated in version-2", () => {
    const context = buildWorkstationContext({
      prompt: "Audit data access policy",
      sources: [
        {
          id: "fit-doc",
          label: "Source 1 · fits.txt",
          text: "Fits in char budget without issues."
        },
        {
          id: "omit-doc",
          label: "Source 2 · large-omitted.txt",
          text: "Long text that will definitely be excluded when the budget is constrained. ".repeat(120)
        }
      ],
      acceptedConstraints: [
        {
          id: "c-sec-1",
          revision: 1,
          kind: "instruction",
          text: "Verify MFA token validity before allowing role escalation.",
          approvedBy: "sec-team",
          approvedAt: "2026-09-23T12:00:00Z"
        }
      ],
      maxChars: 1300
    });

    const parsed = JSON.parse(context.packet) as { omitted: unknown[] };
    expect(parsed.omitted.length).toBeGreaterThan(0);

    render(<ReviewPacket raw={context.packet} />);

    expect(screen.getByText("Approved constraints")).toBeInTheDocument();
    expect(screen.getByText("[c-sec-1] rev 1 [instruction]")).toBeInTheDocument();

    expect(screen.getByText("Retrieved sources (untrusted evidence)")).toBeInTheDocument();
    expect(screen.getByText("fits.txt")).toBeInTheDocument();

    expect(screen.getByText("Not included in this request")).toBeInTheDocument();
    expect(screen.getByText(/large-omitted\.txt: Insufficient maxChars budget/)).toBeInTheDocument();
  });

  it("preserves existing version-1 rendering without constraints or evidence banners", () => {
    const v1Context = buildWorkstationContext({
      prompt: "Explain billing logic",
      sources: [
        {
          id: "src-billing",
          label: "Source 1 · Source · billing-manual.md",
          text: "Invoices are generated on the 1st of every calendar month."
        }
      ]
    });

    const parsed = JSON.parse(v1Context.packet) as { version: string; constraints?: unknown };
    expect(parsed.version).toBe("1");
    expect(parsed.constraints).toBeUndefined();

    render(<ReviewPacket raw={v1Context.packet} />);

    expect(screen.getByText("Your request")).toBeInTheDocument();
    expect(screen.getByText("Explain billing logic")).toBeInTheDocument();
    expect(screen.getByText("Context being shared")).toBeInTheDocument();
    expect(screen.getByText("billing-manual.md")).toBeInTheDocument();
    expect(screen.getByText(/Full selected text · \d+ characters/)).toBeInTheDocument();

    expect(screen.queryByText("Approved constraints")).not.toBeInTheDocument();
    expect(screen.queryByText(/untrusted evidence/i, { selector: ".ws-review-scope-note" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Evidence ·/, { selector: "summary span" })).not.toBeInTheDocument();

    expect(screen.getByText("View the exact packet")).toBeInTheDocument();
  });

  it("safely falls back to raw text for malformed JSON, invalid versions, and incomplete v2 constraints", () => {
    const { container: c1 } = render(<ReviewPacket raw="{ not-valid-json }" />);
    expect(c1.querySelector("pre.ws-source-preview.ws-review-packet")).toHaveTextContent("{ not-valid-json }");
    expect(c1.querySelector(".ws-request-review")).toBeNull();

    const unknownVersionPacket = JSON.stringify({
      version: "3",
      request: "Testing unknown version",
      sources: [],
      omitted: []
    });
    const { container: c2 } = render(<ReviewPacket raw={unknownVersionPacket} />);
    expect(c2.querySelector("pre.ws-source-preview.ws-review-packet")).toHaveTextContent(unknownVersionPacket);
    expect(c2.querySelector(".ws-request-review")).toBeNull();

    const missingConstraintsV2 = JSON.stringify({
      version: "2",
      request: "Testing v2 without constraints array",
      sources: [],
      omitted: []
    });
    const { container: c3 } = render(<ReviewPacket raw={missingConstraintsV2} />);
    expect(c3.querySelector("pre.ws-source-preview.ws-review-packet")).toHaveTextContent(missingConstraintsV2);
    expect(c3.querySelector(".ws-request-review")).toBeNull();

    const invalidConstraintV2 = JSON.stringify({
      version: "2",
      request: "Testing v2 with invalid constraint",
      constraints: [
        {
          id: "bad-1",
          revision: -1,
          kind: "unknown_kind",
          text: "",
          approvedBy: "",
          approvedAt: "",
          inclusionReason: ""
        }
      ],
      sources: [],
      omitted: []
    });
    const { container: c4 } = render(<ReviewPacket raw={invalidConstraintV2} />);
    expect(c4.querySelector("pre.ws-source-preview.ws-review-packet")).toHaveTextContent(invalidConstraintV2);
    expect(c4.querySelector(".ws-request-review")).toBeNull();
  });

  it("renders a realistic version-2 fixture directly and ensures constraints are never hidden in details", () => {
    const fixtureV2 = JSON.stringify({
      version: "2",
      policy: {
        role: "governed_context",
        instructions: "Approved constraints are authoritative instructions, decisions, and exclusions from the owner."
      },
      request: "Configure gateway rate limiting 🛡️",
      constraints: [
        {
          id: "ratelimit-01",
          revision: 5,
          kind: "instruction",
          text: "Global threshold:\n1. Allow 1,000 req/min per tenant.\n2. Burst allowance capped at 1,500 req/min.\n3. Return HTTP 429 with retry-after header.",
          approvedBy: "gatekeeper@cloud.net",
          approvedAt: "2026-09-24T00:00:00Z",
          inclusionReason: "owner_approved_instruction"
        }
      ],
      sources: [
        {
          id: "src-gw",
          label: "Source 1 · gateway-spec.yaml",
          text: "gateway_limits:\n  default: 1000\n  burst: 1500",
          truncated: false
        }
      ],
      omitted: []
    });

    const { container } = render(<ReviewPacket raw={fixtureV2} />);

    expect(screen.getByText("Configure gateway rate limiting 🛡️")).toBeInTheDocument();
    expect(screen.getByText("[ratelimit-01] rev 5 [instruction]")).toBeInTheDocument();
    const constraintPre = screen.getByText(/Return HTTP 429 with retry-after header/, { selector: ".ws-review-constraint-item pre" });
    expect(constraintPre).toBeInTheDocument();
    expect(constraintPre.closest("details")).toBeNull();

    const sourceDetails = screen.getByText("gateway-spec.yaml").closest("details");
    expect(sourceDetails).not.toBeNull();
  });
});
