import { createHash } from "node:crypto";

/**
 * G08: Portable Customer/Operator Workspaces Schema Version
 */
export const PORTABLE_OPERATOR_WORKSPACE_SCHEMA_VERSION = 1 as const;

/**
 * Custom error class for Portable Operator Workspace domain errors.
 */
export class PortableOperatorWorkspaceError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "PortableOperatorWorkspaceError";
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Dependency declaration within an operator workspace manifest.
 */
export interface OperatorDependencyDeclaration {
  readonly id: string;
  readonly kind: "model" | "connector" | "tool" | "asset";
  readonly label: string;
  readonly required: boolean;
  readonly versionConstraint?: string | undefined;
  readonly sha256?: string | undefined;
}

/**
 * Template for operator editable outputs with optional locked regions.
 */
export interface OperatorEditableOutputTemplate {
  readonly id: string;
  readonly title: string;
  readonly format: "markdown" | "json" | "html" | "csv";
  readonly initialContent: string;
  readonly lockedRegions?: readonly string[] | undefined;
}

/**
 * Workflow step template within an operator workspace.
 */
export interface OperatorWorkflowStepTemplate {
  readonly id: string;
  readonly title: string;
  readonly promptTemplate: string;
  readonly requiredDependencyIds: readonly string[];
  readonly outputId?: string | undefined;
}

/**
 * Versioned, portable operator workspace definition.
 */
export interface PortableOperatorWorkspaceDefinition {
  readonly schemaVersion: 1;
  readonly workspaceId: string;
  readonly title: string;
  readonly summary: string;
  readonly Summary: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly dependencies: readonly OperatorDependencyDeclaration[];
  readonly steps: readonly OperatorWorkflowStepTemplate[];
  readonly editableOutputs: readonly OperatorEditableOutputTemplate[];
  readonly manifestDigestSha256: string;
}

/**
 * Explicit customer resource binding approved by resource owner.
 */
export interface CustomerResourceBinding {
  readonly dependencyId: string;
  readonly boundResourceId: string;
  readonly approvedByOwnerAt: string;
}

/**
 * Diagnostic report on a single workspace dependency's availability.
 */
export interface DependencyAvailabilityReport {
  readonly dependencyId: string;
  readonly label: string;
  readonly kind: "model" | "connector" | "tool" | "asset";
  readonly required: boolean;
  readonly available: boolean;
  readonly unavailableReason: string | null;
  readonly boundResourceId: string | null;
}

/**
 * View projection of a portable operator workspace for developer or customer modes.
 */
export interface OperatorWorkspaceView {
  readonly mode: "developer" | "customer";
  readonly workspaceId: string;
  readonly title: string;
  readonly summary: string;
  readonly Summary: string;
  readonly revision: number;
  readonly steps: readonly OperatorWorkflowStepTemplate[];
  readonly editableOutputs: readonly OperatorEditableOutputTemplate[];
  readonly dependencies: readonly DependencyAvailabilityReport[];
  readonly readyToRun: boolean;
  readonly blockedReasons: readonly string[];
  readonly silentPermissionGrants: readonly never[];
}

/**
 * Runtime state of an editable output.
 */
export interface EditableOutputState {
  readonly outputId: string;
  readonly title: string;
  readonly format: "markdown" | "json" | "html" | "csv";
  readonly content: string;
  readonly revision: number;
  readonly lastModifiedAt: string;
  readonly lockedRegions: readonly string[];
}

/**
 * Isolated imported instance of an operator workspace.
 */
export interface OperatorWorkspaceInstance {
  readonly workspaceId: string;
  readonly definition: PortableOperatorWorkspaceDefinition;
  readonly revision: number;
  readonly history: readonly PortableOperatorWorkspaceDefinition[];
  readonly editableOutputs: ReadonlyMap<string, EditableOutputState>;
  readonly customerBindings: ReadonlyMap<string, CustomerResourceBinding>;
  readonly grantedPaths: readonly never[];
}

/**
 * Recursively deep freeze domain objects for immutability.
 */
function deepFreeze<T>(obj: T): T {
  if (obj === null || typeof obj !== "object") {
    return obj;
  }
  Object.freeze(obj);
  for (const key of Object.keys(obj)) {
    const val = (obj as Record<string, unknown>)[key];
    if (val !== null && typeof val === "object" && !Object.isFrozen(val)) {
      deepFreeze(val);
    }
  }
  return obj;
}

/**
 * Deterministic JSON stringify with sorted keys.
 */
function canonicalJsonStringify(obj: unknown): string {
  if (obj === null || typeof obj !== "object") {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return "[" + obj.map(canonicalJsonStringify).join(",") + "]";
  }
  const keys = Object.keys(obj as Record<string, unknown>).sort();
  const pairs = keys.map(
    (k) => `${JSON.stringify(k)}:${canonicalJsonStringify((obj as Record<string, unknown>)[k])}`
  );
  return "{" + pairs.join(",") + "}";
}

/**
 * Computes canonical manifestDigestSha256 over definition payload (excluding the digest itself).
 */
function computeManifestDigest(def: {
  schemaVersion: 1;
  workspaceId: string;
  title: string;
  summary: string;
  revision: number;
  createdAt: string;
  dependencies: readonly OperatorDependencyDeclaration[];
  steps: readonly OperatorWorkflowStepTemplate[];
  editableOutputs: readonly OperatorEditableOutputTemplate[];
}): string {
  const canonicalObj = {
    schemaVersion: def.schemaVersion,
    workspaceId: def.workspaceId,
    title: def.title,
    summary: def.summary,
    revision: def.revision,
    createdAt: def.createdAt,
    dependencies: def.dependencies.map((d) => ({
      id: d.id,
      kind: d.kind,
      label: d.label,
      required: d.required,
      versionConstraint: d.versionConstraint ?? null,
      sha256: d.sha256 ?? null,
    })),
    steps: def.steps.map((s) => ({
      id: s.id,
      title: s.title,
      promptTemplate: s.promptTemplate,
      requiredDependencyIds: [...s.requiredDependencyIds].sort(),
      outputId: s.outputId ?? null,
    })),
    editableOutputs: def.editableOutputs.map((o) => ({
      id: o.id,
      title: o.title,
      format: o.format,
      initialContent: o.initialContent,
      lockedRegions: o.lockedRegions ? [...o.lockedRegions] : [],
    })),
  };

  return createHash("sha256").update(canonicalJsonStringify(canonicalObj), "utf8").digest("hex");
}

/**
 * Validates payload against forbidden private project memory, credentials/tokens,
 * developer connection IDs, and accidental absolute host paths.
 */
function scanForForbiddenContent(value: unknown, currentPath = "$"): void {
  if (value === null || value === undefined) {
    return;
  }

  if (typeof value === "string") {
    if (
      /(?:^|[\s"'`=:(])\/(Users|private|var|etc|home|root)\//i.test(value) ||
      value.startsWith("/Users/") ||
      value.startsWith("/private/") ||
      value.startsWith("/var/") ||
      value.startsWith("/etc/") ||
      value.startsWith("/home/") ||
      value.startsWith("/root/")
    ) {
      throw new PortableOperatorWorkspaceError(
        `Export rejected: accidental absolute host path detected at ${currentPath}: "${value.slice(0, 100)}"`,
        "ERR_FORBIDDEN_HOST_PATH"
      );
    }
    if (/[a-zA-Z]:(?:\\|\/)/.test(value)) {
      throw new PortableOperatorWorkspaceError(
        `Export rejected: Windows host path detected at ${currentPath}: "${value.slice(0, 100)}"`,
        "ERR_FORBIDDEN_HOST_PATH"
      );
    }
    if (/file:\/\/\//i.test(value)) {
      throw new PortableOperatorWorkspaceError(
        `Export rejected: local file URI detected at ${currentPath}: "${value.slice(0, 100)}"`,
        "ERR_FORBIDDEN_HOST_PATH"
      );
    }

    if (/\b(projectMemory|governedMemory|memoryFacts|memoryConflicts)\b/i.test(value)) {
      throw new PortableOperatorWorkspaceError(
        `Export rejected: private project memory reference detected at ${currentPath}: "${value.slice(0, 100)}"`,
        "ERR_FORBIDDEN_PRIVATE_MEMORY"
      );
    }

    if (/\b(developerConnectionId|pairedChatId)\b/i.test(value)) {
      throw new PortableOperatorWorkspaceError(
        `Export rejected: developer connection ID reference detected at ${currentPath}: "${value.slice(0, 100)}"`,
        "ERR_FORBIDDEN_DEVELOPER_CONNECTION"
      );
    }

    if (
      /\b(apiKey|recoveryPhrase|sessionCookie)\b/i.test(value) ||
      /\bsk-[a-zA-Z0-9_\-]{8,}\b/.test(value) ||
      /\bgh[pousr]-[a-zA-Z0-9]{15,}\b/.test(value) ||
      /\bxox[baprs]-[a-zA-Z0-9]{10,}\b/.test(value) ||
      /\bBearer\s+[a-zA-Z0-9_\-\.]{10,}\b/i.test(value)
    ) {
      throw new PortableOperatorWorkspaceError(
        `Export rejected: secret or token pattern detected at ${currentPath}: "${value.slice(0, 100)}"`,
        "ERR_FORBIDDEN_SECRET_OR_TOKEN"
      );
    }

    return;
  }

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      scanForForbiddenContent(value[i], `${currentPath}[${i}]`);
    }
    return;
  }

  if (typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      const childPath = `${currentPath}.${key}`;

      if (/^(projectMemory|governedMemory|memoryFacts|memoryConflicts)$/i.test(key)) {
        throw new PortableOperatorWorkspaceError(
          `Export rejected: forbidden private project memory field "${key}" detected at ${childPath}`,
          "ERR_FORBIDDEN_PRIVATE_MEMORY"
        );
      }
      if (/^(developerConnectionId|accountId|chatId|pairedChatId)$/i.test(key)) {
        throw new PortableOperatorWorkspaceError(
          `Export rejected: forbidden developer connection identifier "${key}" detected at ${childPath}`,
          "ERR_FORBIDDEN_DEVELOPER_CONNECTION"
        );
      }
      if (
        /^(token|secret|apiKey|recoveryPhrase|password|bearer|sessionCookie)$/i.test(key) ||
        /.*(api[_-]?key|recovery[_-]?phrase|session[_-]?cookie|auth[_-]?token|secret[_-]?key).*/i.test(key)
      ) {
        throw new PortableOperatorWorkspaceError(
          `Export rejected: forbidden secret or credential field "${key}" detected at ${childPath}`,
          "ERR_FORBIDDEN_SECRET_OR_TOKEN"
        );
      }

      scanForForbiddenContent(nested, childPath);
    }
  }
}

/**
 * Validates, strips host leaks, computes canonical manifest digest, and freezes
 * an exported PortableOperatorWorkspaceDefinition.
 */
export function exportPortableOperatorWorkspace(input: unknown): PortableOperatorWorkspaceDefinition {
  if (input === null || typeof input !== "object") {
    throw new PortableOperatorWorkspaceError(
      "Workspace input must be a non-null object",
      "ERR_SCHEMA_VIOLATION"
    );
  }

  scanForForbiddenContent(input);

  const raw = input as Record<string, unknown>;

  if (raw.schemaVersion !== PORTABLE_OPERATOR_WORKSPACE_SCHEMA_VERSION) {
    throw new PortableOperatorWorkspaceError(
      `Invalid schemaVersion: expected ${PORTABLE_OPERATOR_WORKSPACE_SCHEMA_VERSION}, received ${String(raw.schemaVersion)}`,
      "ERR_SCHEMA_VIOLATION"
    );
  }

  if (typeof raw.workspaceId !== "string" || !raw.workspaceId.trim()) {
    throw new PortableOperatorWorkspaceError(
      "workspaceId must be a non-empty string",
      "ERR_SCHEMA_VIOLATION"
    );
  }

  if (typeof raw.title !== "string" || !raw.title.trim()) {
    throw new PortableOperatorWorkspaceError(
      "title must be a non-empty string",
      "ERR_SCHEMA_VIOLATION"
    );
  }

  const summary =
    typeof raw.summary === "string"
      ? raw.summary
      : typeof raw.Summary === "string"
        ? raw.Summary
        : "";

  if (typeof raw.revision !== "number" || !Number.isInteger(raw.revision) || raw.revision < 1) {
    throw new PortableOperatorWorkspaceError(
      "revision must be an integer >= 1",
      "ERR_SCHEMA_VIOLATION"
    );
  }

  const createdAt =
    typeof raw.createdAt === "string" && !Number.isNaN(Date.parse(raw.createdAt))
      ? raw.createdAt
      : new Date().toISOString();

  if (!Array.isArray(raw.dependencies)) {
    throw new PortableOperatorWorkspaceError(
      "dependencies must be an array",
      "ERR_SCHEMA_VIOLATION"
    );
  }

  const dependencies: OperatorDependencyDeclaration[] = raw.dependencies.map((dep, idx) => {
    if (dep === null || typeof dep !== "object") {
      throw new PortableOperatorWorkspaceError(
        `dependencies[${idx}] must be an object`,
        "ERR_SCHEMA_VIOLATION"
      );
    }
    const d = dep as Record<string, unknown>;
    if (typeof d.id !== "string" || !d.id.trim()) {
      throw new PortableOperatorWorkspaceError(
        `dependencies[${idx}].id must be a non-empty string`,
        "ERR_SCHEMA_VIOLATION"
      );
    }
    if (d.kind !== "model" && d.kind !== "connector" && d.kind !== "tool" && d.kind !== "asset") {
      throw new PortableOperatorWorkspaceError(
        `dependencies[${idx}].kind must be one of "model" | "connector" | "tool" | "asset"`,
        "ERR_SCHEMA_VIOLATION"
      );
    }
    if (typeof d.label !== "string" || !d.label.trim()) {
      throw new PortableOperatorWorkspaceError(
        `dependencies[${idx}].label must be a non-empty string`,
        "ERR_SCHEMA_VIOLATION"
      );
    }
    if (typeof d.required !== "boolean") {
      throw new PortableOperatorWorkspaceError(
        `dependencies[${idx}].required must be a boolean`,
        "ERR_SCHEMA_VIOLATION"
      );
    }

    return Object.freeze({
      id: d.id,
      kind: d.kind,
      label: d.label,
      required: d.required,
      versionConstraint: typeof d.versionConstraint === "string" ? d.versionConstraint : undefined,
      sha256: typeof d.sha256 === "string" ? d.sha256 : undefined,
    });
  });

  if (!Array.isArray(raw.steps)) {
    throw new PortableOperatorWorkspaceError("steps must be an array", "ERR_SCHEMA_VIOLATION");
  }

  const steps: OperatorWorkflowStepTemplate[] = raw.steps.map((st, idx) => {
    if (st === null || typeof st !== "object") {
      throw new PortableOperatorWorkspaceError(
        `steps[${idx}] must be an object`,
        "ERR_SCHEMA_VIOLATION"
      );
    }
    const s = st as Record<string, unknown>;
    if (typeof s.id !== "string" || !s.id.trim()) {
      throw new PortableOperatorWorkspaceError(
        `steps[${idx}].id must be a non-empty string`,
        "ERR_SCHEMA_VIOLATION"
      );
    }
    if (typeof s.title !== "string" || !s.title.trim()) {
      throw new PortableOperatorWorkspaceError(
        `steps[${idx}].title must be a non-empty string`,
        "ERR_SCHEMA_VIOLATION"
      );
    }
    if (typeof s.promptTemplate !== "string") {
      throw new PortableOperatorWorkspaceError(
        `steps[${idx}].promptTemplate must be a string`,
        "ERR_SCHEMA_VIOLATION"
      );
    }
    if (!Array.isArray(s.requiredDependencyIds)) {
      throw new PortableOperatorWorkspaceError(
        `steps[${idx}].requiredDependencyIds must be an array of strings`,
        "ERR_SCHEMA_VIOLATION"
      );
    }

    return Object.freeze({
      id: s.id,
      title: s.title,
      promptTemplate: s.promptTemplate,
      requiredDependencyIds: Object.freeze(s.requiredDependencyIds.map(String)),
      outputId: typeof s.outputId === "string" ? s.outputId : undefined,
    });
  });

  if (!Array.isArray(raw.editableOutputs)) {
    throw new PortableOperatorWorkspaceError(
      "editableOutputs must be an array",
      "ERR_SCHEMA_VIOLATION"
    );
  }

  const editableOutputs: OperatorEditableOutputTemplate[] = raw.editableOutputs.map((out, idx) => {
    if (out === null || typeof out !== "object") {
      throw new PortableOperatorWorkspaceError(
        `editableOutputs[${idx}] must be an object`,
        "ERR_SCHEMA_VIOLATION"
      );
    }
    const o = out as Record<string, unknown>;
    if (typeof o.id !== "string" || !o.id.trim()) {
      throw new PortableOperatorWorkspaceError(
        `editableOutputs[${idx}].id must be a non-empty string`,
        "ERR_SCHEMA_VIOLATION"
      );
    }
    if (typeof o.title !== "string" || !o.title.trim()) {
      throw new PortableOperatorWorkspaceError(
        `editableOutputs[${idx}].title must be a non-empty string`,
        "ERR_SCHEMA_VIOLATION"
      );
    }
    if (o.format !== "markdown" && o.format !== "json" && o.format !== "html" && o.format !== "csv") {
      throw new PortableOperatorWorkspaceError(
        `editableOutputs[${idx}].format must be "markdown" | "json" | "html" | "csv"`,
        "ERR_SCHEMA_VIOLATION"
      );
    }
    if (typeof o.initialContent !== "string") {
      throw new PortableOperatorWorkspaceError(
        `editableOutputs[${idx}].initialContent must be a string`,
        "ERR_SCHEMA_VIOLATION"
      );
    }

    const lockedRegions = Array.isArray(o.lockedRegions)
      ? Object.freeze(o.lockedRegions.map(String))
      : undefined;

    return Object.freeze({
      id: o.id,
      title: o.title,
      format: o.format,
      initialContent: o.initialContent,
      lockedRegions,
    });
  });

  const manifestDigestSha256 = computeManifestDigest({
    schemaVersion: 1,
    workspaceId: raw.workspaceId,
    title: raw.title,
    summary,
    revision: raw.revision,
    createdAt,
    dependencies,
    steps,
    editableOutputs,
  });

  const definition: PortableOperatorWorkspaceDefinition = {
    schemaVersion: 1,
    workspaceId: raw.workspaceId,
    title: raw.title,
    summary,
    Summary: summary,
    revision: raw.revision,
    createdAt,
    dependencies: Object.freeze(dependencies),
    steps: Object.freeze(steps),
    editableOutputs: Object.freeze(editableOutputs),
    manifestDigestSha256,
  };

  return deepFreeze(definition);
}

/**
 * Verifies that the manifestDigestSha256 strictly matches the canonical definition contents.
 */
export function verifyPortableOperatorWorkspaceDigest(
  definition: PortableOperatorWorkspaceDefinition
): boolean {
  if (!definition || typeof definition !== "object") {
    return false;
  }
  if (typeof definition.manifestDigestSha256 !== "string" || definition.manifestDigestSha256.length !== 64) {
    return false;
  }
  try {
    const computed = computeManifestDigest({
      schemaVersion: definition.schemaVersion,
      workspaceId: definition.workspaceId,
      title: definition.title,
      summary: definition.summary ?? definition.Summary ?? "",
      revision: definition.revision,
      createdAt: definition.createdAt,
      dependencies: definition.dependencies,
      steps: definition.steps,
      editableOutputs: definition.editableOutputs,
    });
    return computed === definition.manifestDigestSha256;
  } catch {
    return false;
  }
}

/**
 * Inspects declared operator dependencies without simulating unavailable resources as connected.
 */
export function inspectOperatorDependencies(
  dependencies: readonly OperatorDependencyDeclaration[],
  options: {
    readonly availableDependencyIds?: ReadonlySet<string> | undefined;
    readonly customerBindings?: ReadonlyMap<string, CustomerResourceBinding> | undefined;
    readonly mode?: "developer" | "customer" | undefined;
  } = {}
): readonly DependencyAvailabilityReport[] {
  const mode = options.mode ?? "developer";
  const availableSet = options.availableDependencyIds ?? new Set<string>();
  const bindings = options.customerBindings ?? new Map<string, CustomerResourceBinding>();

  return Object.freeze(
    dependencies.map((dep) => {
      if (mode === "customer") {
        const binding = bindings.get(dep.id);
        if (!binding) {
          return Object.freeze({
            dependencyId: dep.id,
            label: dep.label,
            kind: dep.kind,
            required: dep.required,
            available: false,
            unavailableReason: `Customer resource binding required for ${dep.kind} "${dep.label}" (${dep.id}). Approval from resource owner is required.`,
            boundResourceId: null,
          });
        }

        if (!availableSet.has(dep.id)) {
          return Object.freeze({
            dependencyId: dep.id,
            label: dep.label,
            kind: dep.kind,
            required: dep.required,
            available: false,
            unavailableReason: `Bound customer resource "${binding.boundResourceId}" for ${dep.kind} "${dep.label}" (${dep.id}) is offline or unavailable.`,
            boundResourceId: binding.boundResourceId,
          });
        }

        return Object.freeze({
          dependencyId: dep.id,
          label: dep.label,
          kind: dep.kind,
          required: dep.required,
          available: true,
          unavailableReason: null,
          boundResourceId: binding.boundResourceId,
        });
      }

      const isAvailable = availableSet.has(dep.id);
      const binding = bindings.get(dep.id);

      return Object.freeze({
        dependencyId: dep.id,
        label: dep.label,
        kind: dep.kind,
        required: dep.required,
        available: isAvailable,
        unavailableReason: isAvailable
          ? null
          : `Dependency ${dep.kind} "${dep.label}" (${dep.id}) is not available in workstation environment.`,
        boundResourceId: binding?.boundResourceId ?? null,
      });
    })
  );
}

/**
 * Projects a unified workspace definition into Developer or Customer mode views.
 */
export function projectOperatorWorkspaceView(
  definition: PortableOperatorWorkspaceDefinition,
  optionsOrMode:
    | "developer"
    | "customer"
    | {
        readonly mode: "developer" | "customer";
        readonly availableDependencyIds?: ReadonlySet<string> | undefined;
        readonly customerBindings?: ReadonlyMap<string, CustomerResourceBinding> | undefined;
      }
): OperatorWorkspaceView {
  const options =
    typeof optionsOrMode === "string"
      ? { mode: optionsOrMode }
      : optionsOrMode;

  const mode = options.mode;
  const availableSet = options.availableDependencyIds ?? new Set<string>();
  const bindings = options.customerBindings ?? new Map<string, CustomerResourceBinding>();

  const dependencyReports = inspectOperatorDependencies(definition.dependencies, {
    mode,
    availableDependencyIds: availableSet,
    customerBindings: bindings,
  });

  const blockedReasons: string[] = [];
  for (const rep of dependencyReports) {
    if (depIsBlocking(rep)) {
      blockedReasons.push(
        rep.unavailableReason ?? `Required dependency "${rep.label}" (${rep.dependencyId}) is unavailable.`
      );
    }
  }

  const readyToRun = blockedReasons.length === 0;
  const summaryVal = definition.summary ?? definition.Summary ?? "";

  return Object.freeze({
    mode,
    workspaceId: definition.workspaceId,
    title: definition.title,
    summary: summaryVal,
    Summary: summaryVal,
    revision: definition.revision,
    steps: definition.steps,
    editableOutputs: definition.editableOutputs,
    dependencies: dependencyReports,
    readyToRun,
    blockedReasons: Object.freeze(blockedReasons),
    silentPermissionGrants: Object.freeze([] as never[]),
  });
}

function depIsBlocking(rep: DependencyAvailabilityReport): boolean {
  return rep.required && !rep.available;
}

/**
 * In-memory / staged operator workspace store supporting isolated imports,
 * locked-region preserved output editing, version updates, and clean rollbacks.
 */
export class PortableOperatorWorkspaceStore {
  private readonly instances = new Map<
    string,
    {
      definition: PortableOperatorWorkspaceDefinition;
      history: PortableOperatorWorkspaceDefinition[];
      editableOutputs: Map<string, EditableOutputState>;
      customerBindings: Map<string, CustomerResourceBinding>;
    }
  >();

  importWorkspace(definition: PortableOperatorWorkspaceDefinition): OperatorWorkspaceInstance {
    if (!verifyPortableOperatorWorkspaceDigest(definition)) {
      throw new PortableOperatorWorkspaceError(
        `Workspace digest verification failed for "${definition.workspaceId}"`,
        "ERR_INVALID_DIGEST"
      );
    }

    if (this.instances.has(definition.workspaceId)) {
      throw new PortableOperatorWorkspaceError(
        `Workspace "${definition.workspaceId}" is already imported in store`,
        "ERR_WORKSPACE_ALREADY_EXISTS"
      );
    }

    const editableOutputs = new Map<string, EditableOutputState>();
    for (const template of definition.editableOutputs) {
      editableOutputs.set(template.id, {
        outputId: template.id,
        title: template.title,
        format: template.format,
        content: template.initialContent,
        revision: 1,
        lastModifiedAt: definition.createdAt,
        lockedRegions: template.lockedRegions ? [...template.lockedRegions] : [],
      });
    }

    const record = {
      definition,
      history: [] as PortableOperatorWorkspaceDefinition[],
      editableOutputs,
      customerBindings: new Map<string, CustomerResourceBinding>(),
    };

    this.instances.set(definition.workspaceId, record);
    return this.buildInstance(definition.workspaceId, record);
  }

  getWorkspace(workspaceId: string): OperatorWorkspaceInstance | undefined {
    const record = this.instances.get(workspaceId);
    if (!record) return undefined;
    return this.buildInstance(workspaceId, record);
  }

  listWorkspaces(): readonly OperatorWorkspaceInstance[] {
    const list: OperatorWorkspaceInstance[] = [];
    for (const [workspaceId, record] of this.instances.entries()) {
      list.push(this.buildInstance(workspaceId, record));
    }
    return Object.freeze(list);
  }

  editOutput(workspaceId: string, outputId: string, newContent: string): EditableOutputState {
    const record = this.instances.get(workspaceId);
    if (!record) {
      throw new PortableOperatorWorkspaceError(
        `Workspace "${workspaceId}" not found`,
        "ERR_WORKSPACE_NOT_FOUND"
      );
    }
    const output = record.editableOutputs.get(outputId);
    if (!output) {
      throw new PortableOperatorWorkspaceError(
        `Output "${outputId}" not found in workspace "${workspaceId}"`,
        "ERR_OUTPUT_NOT_FOUND"
      );
    }

    if (output.lockedRegions && output.lockedRegions.length > 0) {
      for (const locked of output.lockedRegions) {
        if (!newContent.includes(locked)) {
          throw new PortableOperatorWorkspaceError(
            `Modification of output "${outputId}" violated locked region constraint: missing "${locked}"`,
            "ERR_LOCKED_REGION_MODIFIED"
          );
        }
      }
    }

    const updated: EditableOutputState = {
      outputId: output.outputId,
      title: output.title,
      format: output.format,
      content: newContent,
      revision: output.revision + 1,
      lastModifiedAt: new Date().toISOString(),
      lockedRegions: output.lockedRegions,
    };

    record.editableOutputs.set(outputId, updated);
    return Object.freeze({ ...updated });
  }

  updateWorkspace(
    workspaceId: string,
    nextDefinition: PortableOperatorWorkspaceDefinition
  ): OperatorWorkspaceInstance {
    const record = this.instances.get(workspaceId);
    if (!record) {
      throw new PortableOperatorWorkspaceError(
        `Workspace "${workspaceId}" not found`,
        "ERR_WORKSPACE_NOT_FOUND"
      );
    }

    if (nextDefinition.workspaceId !== workspaceId) {
      throw new PortableOperatorWorkspaceError(
        `Next definition workspaceId "${nextDefinition.workspaceId}" does not match target "${workspaceId}"`,
        "ERR_WORKSPACE_ID_MISMATCH"
      );
    }

    if (!verifyPortableOperatorWorkspaceDigest(nextDefinition)) {
      throw new PortableOperatorWorkspaceError(
        `Next definition digest verification failed for "${workspaceId}"`,
        "ERR_INVALID_DIGEST"
      );
    }

    if (nextDefinition.revision <= record.definition.revision) {
      throw new PortableOperatorWorkspaceError(
        `Update requires higher revision than current (${record.definition.revision}), received ${nextDefinition.revision}`,
        "ERR_INVALID_REVISION"
      );
    }

    record.history.push(record.definition);

    const nextOutputs = new Map<string, EditableOutputState>();
    for (const template of nextDefinition.editableOutputs) {
      const existing = record.editableOutputs.get(template.id);
      const requiredLocked = template.lockedRegions ?? [];

      if (existing) {
        const isCompatible =
          existing.format === template.format &&
          requiredLocked.every((region) => existing.content.includes(region));

        if (isCompatible) {
          nextOutputs.set(template.id, {
            ...existing,
            title: template.title,
            lockedRegions: requiredLocked,
          });
        } else {
          nextOutputs.set(template.id, {
            outputId: template.id,
            title: template.title,
            format: template.format,
            content: template.initialContent,
            revision: 1,
            lastModifiedAt: nextDefinition.createdAt,
            lockedRegions: requiredLocked,
          });
        }
      } else {
        nextOutputs.set(template.id, {
          outputId: template.id,
          title: template.title,
          format: template.format,
          content: template.initialContent,
          revision: 1,
          lastModifiedAt: nextDefinition.createdAt,
          lockedRegions: requiredLocked,
        });
      }
    }

    record.editableOutputs = nextOutputs;
    record.definition = nextDefinition;

    return this.buildInstance(workspaceId, record);
  }

  rollbackWorkspace(workspaceId: string): OperatorWorkspaceInstance {
    const record = this.instances.get(workspaceId);
    if (!record) {
      throw new PortableOperatorWorkspaceError(
        `Workspace "${workspaceId}" not found`,
        "ERR_WORKSPACE_NOT_FOUND"
      );
    }

    if (record.history.length === 0) {
      throw new PortableOperatorWorkspaceError(
        `No prior definition revision available to rollback for "${workspaceId}"`,
        "ERR_NO_ROLLBACK_AVAILABLE"
      );
    }

    const previousDefinition = record.history.pop()!;
    record.definition = previousDefinition;

    const rolledBackOutputs = new Map<string, EditableOutputState>();
    for (const template of previousDefinition.editableOutputs) {
      const existing = record.editableOutputs.get(template.id);
      const requiredLocked = template.lockedRegions ?? [];

      if (existing) {
        const isCompatible =
          existing.format === template.format &&
          requiredLocked.every((region) => existing.content.includes(region));

        if (isCompatible) {
          rolledBackOutputs.set(template.id, {
            ...existing,
            title: template.title,
            lockedRegions: requiredLocked,
          });
        } else {
          rolledBackOutputs.set(template.id, {
            outputId: template.id,
            title: template.title,
            format: template.format,
            content: template.initialContent,
            revision: 1,
            lastModifiedAt: previousDefinition.createdAt,
            lockedRegions: requiredLocked,
          });
        }
      } else {
        rolledBackOutputs.set(template.id, {
          outputId: template.id,
          title: template.title,
          format: template.format,
          content: template.initialContent,
          revision: 1,
          lastModifiedAt: previousDefinition.createdAt,
          lockedRegions: requiredLocked,
        });
      }
    }

    record.editableOutputs = rolledBackOutputs;
    return this.buildInstance(workspaceId, record);
  }

  bindCustomerResource(
    workspaceId: string,
    dependencyId: string,
    boundResourceId: string,
    approvedByOwnerAt?: string
  ): CustomerResourceBinding {
    const record = this.instances.get(workspaceId);
    if (!record) {
      throw new PortableOperatorWorkspaceError(
        `Workspace "${workspaceId}" not found`,
        "ERR_WORKSPACE_NOT_FOUND"
      );
    }

    const dep = record.definition.dependencies.find((d) => d.id === dependencyId);
    if (!dep) {
      throw new PortableOperatorWorkspaceError(
        `Dependency "${dependencyId}" not found in workspace "${workspaceId}"`,
        "ERR_DEPENDENCY_NOT_FOUND"
      );
    }

    const binding: CustomerResourceBinding = {
      dependencyId,
      boundResourceId,
      approvedByOwnerAt: approvedByOwnerAt ?? new Date().toISOString(),
    };

    record.customerBindings.set(dependencyId, binding);
    return Object.freeze({ ...binding });
  }

  projectWorkspaceView(
    workspaceId: string,
    options: {
      readonly mode: "developer" | "customer";
      readonly availableDependencyIds: ReadonlySet<string>;
    }
  ): OperatorWorkspaceView {
    const record = this.instances.get(workspaceId);
    if (!record) {
      throw new PortableOperatorWorkspaceError(
        `Workspace "${workspaceId}" not found`,
        "ERR_WORKSPACE_NOT_FOUND"
      );
    }

    return projectOperatorWorkspaceView(record.definition, {
      mode: options.mode,
      availableDependencyIds: options.availableDependencyIds,
      customerBindings: record.customerBindings,
    });
  }

  private buildInstance(
    workspaceId: string,
    record: {
      definition: PortableOperatorWorkspaceDefinition;
      history: PortableOperatorWorkspaceDefinition[];
      editableOutputs: Map<string, EditableOutputState>;
      customerBindings: Map<string, CustomerResourceBinding>;
    }
  ): OperatorWorkspaceInstance {
    const outputsMap = new Map(record.editableOutputs);
    const bindingsMap = new Map(record.customerBindings);

    return Object.freeze({
      workspaceId,
      definition: record.definition,
      revision: record.definition.revision,
      history: Object.freeze([...record.history]),
      editableOutputs: outputsMap,
      customerBindings: bindingsMap,
      grantedPaths: Object.freeze([] as never[]),
    });
  }
}

export const PortableOperatorWorkspaceRegistry = PortableOperatorWorkspaceStore;

export const defaultOperatorWorkspaceStore = new PortableOperatorWorkspaceStore();

export function importPortableOperatorWorkspace(
  definition: PortableOperatorWorkspaceDefinition,
  store: PortableOperatorWorkspaceStore = defaultOperatorWorkspaceStore
): OperatorWorkspaceInstance {
  return store.importWorkspace(definition);
}

export function updatePortableOperatorWorkspace(
  workspaceId: string,
  nextDefinition: PortableOperatorWorkspaceDefinition,
  store: PortableOperatorWorkspaceStore = defaultOperatorWorkspaceStore
): OperatorWorkspaceInstance {
  return store.updateWorkspace(workspaceId, nextDefinition);
}

export function rollbackPortableOperatorWorkspace(
  workspaceId: string,
  store: PortableOperatorWorkspaceStore = defaultOperatorWorkspaceStore
): OperatorWorkspaceInstance {
  return store.rollbackWorkspace(workspaceId);
}

export function bindCustomerResource(
  storeOrInstance: PortableOperatorWorkspaceStore | OperatorWorkspaceInstance,
  workspaceIdOrDepId: string,
  depIdOrResourceId: string,
  resourceIdOrApprovedAt?: string,
  approvedAt?: string
): CustomerResourceBinding {
  if (storeOrInstance instanceof PortableOperatorWorkspaceStore) {
    return storeOrInstance.bindCustomerResource(
      workspaceIdOrDepId,
      depIdOrResourceId,
      resourceIdOrApprovedAt!,
      approvedAt
    );
  }

  const instance = storeOrInstance;
  const dependencyId = workspaceIdOrDepId;
  const boundResourceId = depIdOrResourceId;
  const approvedByOwnerAt = resourceIdOrApprovedAt ?? new Date().toISOString();

  const dep = instance.definition.dependencies.find((d) => d.id === dependencyId);
  if (!dep) {
    throw new PortableOperatorWorkspaceError(
      `Dependency "${dependencyId}" not found in workspace "${instance.workspaceId}"`,
      "ERR_DEPENDENCY_NOT_FOUND"
    );
  }

  const binding: CustomerResourceBinding = {
    dependencyId,
    boundResourceId,
    approvedByOwnerAt,
  };

  if (instance.customerBindings instanceof Map) {
    (instance.customerBindings as Map<string, CustomerResourceBinding>).set(dependencyId, binding);
  }

  return Object.freeze({ ...binding });
}
