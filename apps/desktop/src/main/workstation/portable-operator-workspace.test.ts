import { describe, it, expect, beforeEach } from "vitest";
import {
  PORTABLE_OPERATOR_WORKSPACE_SCHEMA_VERSION,
  PortableOperatorWorkspaceError,
  exportPortableOperatorWorkspace,
  verifyPortableOperatorWorkspaceDigest,
  projectOperatorWorkspaceView,
  inspectOperatorDependencies,
  bindCustomerResource,
  PortableOperatorWorkspaceStore,
  type PortableOperatorWorkspaceDefinition,
  type CustomerResourceBinding,
} from "./portable-operator-workspace.js";

function createValidWorkspaceInput(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    workspaceId: "ws-support-triage",
    title: "Support Ticket Triage Operator",
    summary: "Automated triage and escalation assistant for customer tickets.",
    Summary: "Automated triage and escalation assistant for customer tickets.",
    revision: 1,
    createdAt: "2026-09-24T12:00:00.000Z",
    dependencies: [
      {
        id: "model-primary",
        kind: "model",
        label: "Gemini 2.5 Flash Operator Model",
        required: true,
        versionConstraint: ">=2.5.0",
      },
      {
        id: "crm-connector",
        kind: "connector",
        label: "Zendesk Support Connector",
        required: true,
      },
      {
        id: "slack-notifier",
        kind: "tool",
        label: "Slack Escalation Webhook",
        required: false,
      },
    ],
    steps: [
      {
        id: "step-fetch",
        title: "Fetch incoming unassigned tickets",
        promptTemplate: "Retrieve unassigned tickets for queue triage.",
        requiredDependencyIds: ["crm-connector"],
      },
      {
        id: "step-classify",
        title: "Classify and draft response",
        promptTemplate: "Analyze ticket sentiment and draft initial response.",
        requiredDependencyIds: ["model-primary"],
        outputId: "out-triage-summary",
      },
    ],
    editableOutputs: [
      {
        id: "out-triage-summary",
        title: "Triage Summary & Draft Responses",
        format: "markdown",
        initialContent:
          "# Triage Report\n<!-- LOCKED: SYSTEM_DISCLAIMER -->\nConfidential operator assessment.\n<!-- END_LOCKED -->\nNo tickets triaged yet.",
        lockedRegions: [
          "<!-- LOCKED: SYSTEM_DISCLAIMER -->\nConfidential operator assessment.\n<!-- END_LOCKED -->",
        ],
      },
    ],
    ...overrides,
  };
}

describe("Portable Operator Workspaces Backend (G08)", () => {
  let store: PortableOperatorWorkspaceStore;

  beforeEach(() => {
    store = new PortableOperatorWorkspaceStore();
  });

  describe("Requirement 1: Schema Version, Deterministic Digest & Verification", () => {
    it("exports a valid workspace definition with schema version 1 and computes a deterministic manifestDigestSha256", () => {
      const raw = createValidWorkspaceInput();
      const exported1 = exportPortableOperatorWorkspace(raw);
      const exported2 = exportPortableOperatorWorkspace(raw);

      expect(exported1.schemaVersion).toBe(PORTABLE_OPERATOR_WORKSPACE_SCHEMA_VERSION);
      expect(exported1.schemaVersion).toBe(1);
      expect(typeof exported1.manifestDigestSha256).toBe("string");
      expect(exported1.manifestDigestSha256).toHaveLength(64);
      expect(/^[0-9a-f]{64}$/.test(exported1.manifestDigestSha256)).toBe(true);

      expect(exported1.manifestDigestSha256).toBe(exported2.manifestDigestSha256);
      expect(exported1.workspaceId).toBe("ws-support-triage");
      expect(exported1.title).toBe("Support Ticket Triage Operator");

      expect(Object.isFrozen(exported1)).toBe(true);
      expect(Object.isFrozen(exported1.dependencies)).toBe(true);
      expect(Object.isFrozen(exported1.steps)).toBe(true);
      expect(Object.isFrozen(exported1.editableOutputs)).toBe(true);
    });

    it("passes digest verification on untouched definitions and fails on tampered payloads", () => {
      const exported = exportPortableOperatorWorkspace(createValidWorkspaceInput());
      expect(verifyPortableOperatorWorkspaceDigest(exported)).toBe(true);

      const tamperedTitle = { ...exported, title: "Malicious Tampered Title" };
      expect(verifyPortableOperatorWorkspaceDigest(tamperedTitle as PortableOperatorWorkspaceDefinition)).toBe(false);

      const tamperedDeps = {
        ...exported,
        dependencies: [
          ...exported.dependencies,
          { id: "extra-tool", kind: "tool" as const, label: "Extra", required: false },
        ],
      };
      expect(verifyPortableOperatorWorkspaceDigest(tamperedDeps as PortableOperatorWorkspaceDefinition)).toBe(false);

      const tamperedStep = {
        ...exported,
        steps: [
          {
            ...exported.steps[0]!,
            promptTemplate: "Tampered prompt template content",
          },
        ],
      };
      expect(verifyPortableOperatorWorkspaceDigest(tamperedStep as PortableOperatorWorkspaceDefinition)).toBe(false);
    });
  });

  describe("Requirement 2: Strict Security & Private Leakage Rejection", () => {
    it("rejects payloads containing private project memory", () => {
      expect(() =>
        exportPortableOperatorWorkspace(
          createValidWorkspaceInput({
            projectMemory: { facts: ["user preferred database password is X"] },
          })
        )
      ).toThrow(PortableOperatorWorkspaceError);

      try {
        exportPortableOperatorWorkspace(
          createValidWorkspaceInput({ projectMemory: { facts: [] } })
        );
      } catch (err) {
        expect((err as PortableOperatorWorkspaceError).code).toBe("ERR_FORBIDDEN_PRIVATE_MEMORY");
      }

      expect(() =>
        exportPortableOperatorWorkspace(
          createValidWorkspaceInput({
            summary: "Uses governedMemory to persist customer secrets",
          })
        )
      ).toThrowError(/private project memory/i);

      expect(() =>
        exportPortableOperatorWorkspace(
          createValidWorkspaceInput({
            memoryFacts: ["fact 1", "fact 2"],
          })
        )
      ).toThrow(PortableOperatorWorkspaceError);
    });

    it("rejects payloads containing tokens and secrets", () => {
      expect(() =>
        exportPortableOperatorWorkspace(
          createValidWorkspaceInput({
            apiKey: "secret-key-value-12345",
          })
        )
      ).toThrow(PortableOperatorWorkspaceError);

      try {
        exportPortableOperatorWorkspace(createValidWorkspaceInput({ apiKey: "sk-12345678" }));
      } catch (err) {
        expect((err as PortableOperatorWorkspaceError).code).toBe("ERR_FORBIDDEN_SECRET_OR_TOKEN");
      }

      expect(() =>
        exportPortableOperatorWorkspace(
          createValidWorkspaceInput({
            steps: [
              {
                id: "step-leaked",
                title: "Leak step",
                promptTemplate: "Use recoveryPhrase: apple banana cherry dog elephant fox grape",
                requiredDependencyIds: [],
              },
            ],
          })
        )
      ).toThrowError(/secret or token/i);

      expect(() =>
        exportPortableOperatorWorkspace(
          createValidWorkspaceInput({
            editableOutputs: [
              {
                id: "out-leak",
                title: "Leak",
                format: "markdown",
                initialContent: "Default token sk-proj99887766554433221100aabbccdd",
              },
            ],
          })
        )
      ).toThrow(PortableOperatorWorkspaceError);

      expect(() =>
        exportPortableOperatorWorkspace(
          createValidWorkspaceInput({
            summary: "Authorization Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
          })
        )
      ).toThrow(PortableOperatorWorkspaceError);
    });

    it("rejects payloads containing developer connection IDs", () => {
      expect(() =>
        exportPortableOperatorWorkspace(
          createValidWorkspaceInput({
            developerConnectionId: "dev-conn-local-42",
          })
        )
      ).toThrow(PortableOperatorWorkspaceError);

      try {
        exportPortableOperatorWorkspace(
          createValidWorkspaceInput({ developerConnectionId: "conn-1" })
        );
      } catch (err) {
        expect((err as PortableOperatorWorkspaceError).code).toBe(
          "ERR_FORBIDDEN_DEVELOPER_CONNECTION"
        );
      }

      expect(() =>
        exportPortableOperatorWorkspace(
          createValidWorkspaceInput({
            steps: [
              {
                id: "step-conn",
                title: "Forwarding",
                promptTemplate: "Send to developerConnectionId conn-777",
                requiredDependencyIds: [],
              },
            ],
          })
        )
      ).toThrowError(/developer connection ID/i);

      expect(() =>
        exportPortableOperatorWorkspace(
          createValidWorkspaceInput({
            pairedChatId: "telegram-chat-99901",
          })
        )
      ).toThrow(PortableOperatorWorkspaceError);
    });

    it("rejects payloads containing accidental absolute host paths", () => {
      expect(() =>
        exportPortableOperatorWorkspace(
          createValidWorkspaceInput({
            steps: [
              {
                id: "step-path",
                title: "Local scan",
                promptTemplate: "Read files from /Users/alice/Documents/receipts",
                requiredDependencyIds: [],
              },
            ],
          })
        )
      ).toThrow(PortableOperatorWorkspaceError);

      try {
        exportPortableOperatorWorkspace(
          createValidWorkspaceInput({
            summary: "Logs located at /Users/alice/Documents/operator.log",
          })
        );
      } catch (err) {
        expect((err as PortableOperatorWorkspaceError).code).toBe("ERR_FORBIDDEN_HOST_PATH");
      }

      expect(() =>
        exportPortableOperatorWorkspace(
          createValidWorkspaceInput({
            editableOutputs: [
              {
                id: "out-path",
                title: "Log",
                format: "markdown",
                initialContent: "Output path: C:\\Users\\alice\\Desktop\\output.txt",
              },
            ],
          })
        )
      ).toThrow(PortableOperatorWorkspaceError);

      expect(() =>
        exportPortableOperatorWorkspace(
          createValidWorkspaceInput({
            summary: "Resource loaded from file:///Users/alice/data.csv",
          })
        )
      ).toThrow(PortableOperatorWorkspaceError);

      expect(() =>
        exportPortableOperatorWorkspace(
          createValidWorkspaceInput({
            summary: "Temp storage at /var/folders/xx/temporary",
          })
        )
      ).toThrow(PortableOperatorWorkspaceError);
    });
  });

  describe("Requirement 3: Developer & Customer Mode View Projections", () => {
    it("projects the exact same domain object in developer and customer modes with explicit dependency states and zero silent grants", () => {
      const definition = exportPortableOperatorWorkspace(createValidWorkspaceInput());

      const devView = projectOperatorWorkspaceView(definition, {
        mode: "developer",
        availableDependencyIds: new Set(["model-primary"]),
      });

      expect(devView.mode).toBe("developer");
      expect(devView.workspaceId).toBe(definition.workspaceId);
      expect(devView.title).toBe(definition.title);
      expect(devView.summary).toBe(definition.summary);
      expect(devView.Summary).toBe(definition.summary);
      expect(devView.revision).toBe(definition.revision);
      expect(devView.steps).toBe(definition.steps);
      expect(devView.editableOutputs).toBe(definition.editableOutputs);

      expect(devView.silentPermissionGrants).toEqual([]);

      const devModel = devView.dependencies.find((d) => d.dependencyId === "model-primary")!;
      const devCrm = devView.dependencies.find((d) => d.dependencyId === "crm-connector")!;
      const devSlack = devView.dependencies.find((d) => d.dependencyId === "slack-notifier")!;

      expect(devModel.available).toBe(true);
      expect(devModel.unavailableReason).toBeNull();
      expect(devCrm.available).toBe(false);
      expect(devCrm.unavailableReason).toMatch(/not available in workstation/i);

      expect(devSlack.available).toBe(false);

      expect(devView.readyToRun).toBe(false);
      expect(devView.blockedReasons.length).toBeGreaterThan(0);
      expect(devView.blockedReasons[0]).toMatch(/crm-connector/);

      const custViewUnbound = projectOperatorWorkspaceView(definition, {
        mode: "customer",
        availableDependencyIds: new Set(["model-primary", "crm-connector"]),
        customerBindings: new Map(),
      });

      expect(custViewUnbound.mode).toBe("customer");
      expect(custViewUnbound.silentPermissionGrants).toEqual([]);

      const custModel = custViewUnbound.dependencies.find((d) => d.dependencyId === "model-primary")!;
      expect(custModel.available).toBe(false);
      expect(custModel.unavailableReason).toMatch(/Customer resource binding required/i);
      expect(custViewUnbound.readyToRun).toBe(false);

      const bindings = new Map<string, CustomerResourceBinding>([
        [
          "model-primary",
          {
            dependencyId: "model-primary",
            boundResourceId: "customer-openai-prod",
            approvedByOwnerAt: "2026-09-24T13:00:00.000Z",
          },
        ],
        [
          "crm-connector",
          {
            dependencyId: "crm-connector",
            boundResourceId: "customer-zendesk-instance-91",
            approvedByOwnerAt: "2026-09-24T13:05:00.000Z",
          },
        ],
      ]);

      const custViewBound = projectOperatorWorkspaceView(definition, {
        mode: "customer",
        availableDependencyIds: new Set(["model-primary", "crm-connector"]),
        customerBindings: bindings,
      });

      expect(custViewBound.readyToRun).toBe(true);
      expect(custViewBound.blockedReasons).toEqual([]);
      expect(custViewBound.silentPermissionGrants).toEqual([]);

      const boundModel = custViewBound.dependencies.find((d) => d.dependencyId === "model-primary")!;
      expect(boundModel.available).toBe(true);
      expect(boundModel.boundResourceId).toBe("customer-openai-prod");
      expect(boundModel.unavailableReason).toBeNull();
    });

    it("inspectOperatorDependencies reports unavailable dependencies without simulating connection", () => {
      const definition = exportPortableOperatorWorkspace(createValidWorkspaceInput());
      const reports = inspectOperatorDependencies(definition.dependencies, {
        mode: "developer",
        availableDependencyIds: new Set(),
      });

      expect(reports).toHaveLength(3);
      for (const rep of reports) {
        expect(rep.available).toBe(false);
        expect(rep.unavailableReason).toBeTruthy();
      }
    });
  });

  describe("Requirement 4: Isolated Import, Editable Outputs, Update & Rollback", () => {
    it("imports workspaces into isolated instances with empty permission grants and protects outputs from cross-instance mutation", () => {
      const def1 = exportPortableOperatorWorkspace(createValidWorkspaceInput());
      const def2 = exportPortableOperatorWorkspace(
        createValidWorkspaceInput({
          workspaceId: "ws-isolated-second",
          title: "Second Isolated Workspace",
        })
      );

      const inst1 = store.importWorkspace(def1);
      const inst2 = store.importWorkspace(def2);

      expect(inst1.workspaceId).toBe("ws-support-triage");
      expect(inst2.workspaceId).toBe("ws-isolated-second");
      expect(inst1.grantedPaths).toEqual([]);
      expect(inst2.grantedPaths).toEqual([]);

      const initialOut = inst1.editableOutputs.get("out-triage-summary")!;
      expect(initialOut.revision).toBe(1);

      const updatedOut1 = store.editOutput(
        inst1.workspaceId,
        "out-triage-summary",
        "# Triage Report\n<!-- LOCKED: SYSTEM_DISCLAIMER -->\nConfidential operator assessment.\n<!-- END_LOCKED -->\nOperator note: triaged 10 tickets."
      );

      expect(updatedOut1.revision).toBe(2);
      expect(updatedOut1.content).toContain("Operator note: triaged 10 tickets.");

      const inst2Outputs = store.getWorkspace("ws-isolated-second")!.editableOutputs;
      expect(inst2Outputs.get("out-triage-summary")!.revision).toBe(1);
      expect(inst2Outputs.get("out-triage-summary")!.content).toBe(initialOut.content);
    });

    it("enforces locked regions when editing output and rejects tampering", () => {
      const def = exportPortableOperatorWorkspace(createValidWorkspaceInput());
      store.importWorkspace(def);

      const lockedSnippet =
        "<!-- LOCKED: SYSTEM_DISCLAIMER -->\nConfidential operator assessment.\n<!-- END_LOCKED -->";

      const validEdit = store.editOutput(
        def.workspaceId,
        "out-triage-summary",
        `# Header\n${lockedSnippet}\nCustom user content here.`
      );
      expect(validEdit.revision).toBe(2);

      expect(() =>
        store.editOutput(
          def.workspaceId,
          "out-triage-summary",
          "# Header\nDisclaimer removed by attacker.\nCustom user content."
        )
      ).toThrow(PortableOperatorWorkspaceError);

      try {
        store.editOutput(
          def.workspaceId,
          "out-triage-summary",
          "# Header without required disclaimer"
        );
      } catch (err) {
        expect((err as PortableOperatorWorkspaceError).code).toBe("ERR_LOCKED_REGION_MODIFIED");
      }

      const current = store.getWorkspace(def.workspaceId)!.editableOutputs.get("out-triage-summary")!;
      expect(current.revision).toBe(2);
    });

    it("supports versioned update (revision: 2) and clean rollback to revision 1", () => {
      const defRev1 = exportPortableOperatorWorkspace(createValidWorkspaceInput({ revision: 1 }));
      store.importWorkspace(defRev1);

      store.editOutput(
        defRev1.workspaceId,
        "out-triage-summary",
        "# Triage Report\n<!-- LOCKED: SYSTEM_DISCLAIMER -->\nConfidential operator assessment.\n<!-- END_LOCKED -->\nEdited in rev 1."
      );

      const defRev2 = exportPortableOperatorWorkspace(
        createValidWorkspaceInput({
          revision: 2,
          title: "Support Ticket Triage Operator v2",
          steps: [
            ...defRev1.steps,
            {
              id: "step-escalate",
              title: "Escalate urgent issues",
              promptTemplate: "Notify tier 3 support.",
              requiredDependencyIds: ["slack-notifier"],
            },
          ],
        })
      );

      const updatedInst = store.updateWorkspace(defRev1.workspaceId, defRev2);
      expect(updatedInst.definition.revision).toBe(2);
      expect(updatedInst.definition.title).toBe("Support Ticket Triage Operator v2");
      expect(updatedInst.history).toHaveLength(1);
      expect(updatedInst.history[0]!.revision).toBe(1);

      const preservedOutput = updatedInst.editableOutputs.get("out-triage-summary")!;
      expect(preservedOutput.content).toContain("Edited in rev 1.");
      expect(preservedOutput.revision).toBe(2);

      expect(() => store.updateWorkspace(defRev1.workspaceId, defRev2)).toThrow(
        PortableOperatorWorkspaceError
      );

      const rolledBackInst = store.rollbackWorkspace(defRev1.workspaceId);
      expect(rolledBackInst.definition.revision).toBe(1);
      expect(rolledBackInst.definition.title).toBe("Support Ticket Triage Operator");
      expect(rolledBackInst.history).toHaveLength(0);

      expect(() => store.rollbackWorkspace(defRev1.workspaceId)).toThrow(
        PortableOperatorWorkspaceError
      );
      try {
        store.rollbackWorkspace(defRev1.workspaceId);
      } catch (err) {
        expect((err as PortableOperatorWorkspaceError).code).toBe("ERR_NO_ROLLBACK_AVAILABLE");
      }
    });

    it("binds customer resources explicitly and updates workspace view accordingly", () => {
      const def = exportPortableOperatorWorkspace(createValidWorkspaceInput());
      const inst = store.importWorkspace(def);

      expect(inst.customerBindings.size).toBe(0);

      const binding = bindCustomerResource(
        store,
        def.workspaceId,
        "crm-connector",
        "zendesk-enterprise-prod"
      );

      expect(binding.dependencyId).toBe("crm-connector");
      expect(binding.boundResourceId).toBe("zendesk-enterprise-prod");
      expect(typeof binding.approvedByOwnerAt).toBe("string");

      const view = store.projectWorkspaceView(def.workspaceId, {
        mode: "customer",
        availableDependencyIds: new Set(["model-primary", "crm-connector"]),
      });

      const crmReport = view.dependencies.find((d) => d.dependencyId === "crm-connector")!;
      expect(crmReport.boundResourceId).toBe("zendesk-enterprise-prod");
      expect(crmReport.available).toBe(true);
    });
  });
});
