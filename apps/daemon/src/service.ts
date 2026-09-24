import path from "node:path";
import {
  AutomationAgentSchema,
  AutomationArtifactSchema,
  AutomationConnectorSchema,
  AutomationMemoryDocumentSchema,
  AutomationDryRunSchema,
  AutomationRunSnapshotSchema,
  AutomationSourceDocumentSchema,
  AutomationWorkflowSchema,
  AutomationWorkspaceSnapshotSchema,
  AutomationWorkflowPackSchema,
  ConciergeSnapshotSchema,
  DesktopErrorSchema,
  GgufInspectionSchema,
  HardwareProfileSchema,
  LicenseAcknowledgementSchema,
  ModelInstallCancelResultSchema,
  ModelInstallSnapshotSchema,
  ModelInstallStatusSchema,
  ModelLicenseReviewSchema,
  RuntimeDescriptorSchema,
  type DaemonRequest,
  type DesktopError,
  type LocalChatRequest,
  type ModelTarget,
  type RuntimeDescriptor,
  type SignedModelCatalog
} from "@cadrane/contracts";
import {
  FileLicenseAcknowledgementStore,
  inspectGguf,
  loadStaticBetaModelCatalog,
  LlamaServerSupervisor,
  LmStudioAdapter,
  LocalRuntimeManager,
  ManagedLlamaAdapter,
  ManagedModelInstaller,
  ModelInstallController,
  ModelLicenseService,
  OllamaAdapter,
  profileHardware,
  rankOpenWeightModels,
  RuntimeBoundaryError,
  SingleLaneScheduler,
  STARTER_CATALOG_REVIEWED_AT,
  STARTER_OPEN_WEIGHT_CATALOG,
  toDesktopError,
  UnavailableManagedRuntimeActivationSource,
  type ManagedRuntimeActivationSource,
  type ModelDownloadTransport
} from "@cadrane/runtime";
import { z } from "zod";
import {
  AutomationRuntime,
  EncryptedFileAutomationRepository
} from "./automation-runtime.js";

const MANAGED_MODEL_DIRECTORY = path.join(
  "local-intelligence",
  "managed-models"
);
export const MANAGED_MODEL_DOWNLOAD_REDIRECT_POLICY = Object.freeze({
  allowedRedirectOrigins: Object.freeze([
    "https://us.aws.cdn.hf.co"
  ] as const),
  maximumRedirects: 3
});

export type DaemonWorkRequest = Exclude<
  DaemonRequest,
  { type: "request.cancel" }
>;

export interface DaemonRuntimeBoundary {
  discover(): Promise<RuntimeDescriptor[]>;
  chat(request: LocalChatRequest): Promise<unknown>;
  cancel(operationId: string): boolean;
  shutdown(): Promise<void>;
}

export interface DaemonModelInstallBoundary {
  snapshot(): Promise<unknown>;
  review(modelId: string): Promise<unknown>;
  acknowledge(intent: unknown): Promise<unknown>;
  start(modelId: string, signal?: AbortSignal): Promise<unknown>;
  cancel(operationId: string): Promise<unknown>;
}

export interface DaemonAutomationBoundary {
  snapshot(): Promise<unknown>;
  saveAgent(input: unknown): Promise<unknown>;
  saveWorkflow(input: unknown): Promise<unknown>;
  saveMemory(input: unknown): Promise<unknown>;
  saveSource(input: unknown): Promise<unknown>;
  reviewArtifact(input: unknown): Promise<unknown>;
  ensureLocalConnector(input: unknown): Promise<unknown>;
  exportPack(workflowId: string): Promise<unknown>;
  importPack(input: unknown): Promise<unknown>;
  dryRun(workflowId: string): Promise<unknown>;
  folderChanged(root: string): Promise<void>;
  start(input: unknown): Promise<unknown>;
  action(input: unknown): Promise<unknown>;
  shutdown(): Promise<void>;
}

export interface DaemonDispatcherDependencies {
  readonly dataDirectory: string;
  readonly runtimeManager: DaemonRuntimeBoundary;
  readonly automationRuntime?: DaemonAutomationBoundary;
  readonly automationKeySource?: ConstructorParameters<
    typeof EncryptedFileAutomationRepository
  >[1];
  readonly installBoundary: DaemonModelInstallBoundary | null;
  readonly installUnavailableError: RuntimeBoundaryError | null;
  readonly profile: (dataDirectory: string) => Promise<unknown>;
  readonly inspect: (
    selectedPath: string,
    signal: AbortSignal
  ) => Promise<{ inspection: unknown }>;
}

export interface CreateDaemonDispatcherOptions {
  readonly dataDirectory: string;
  readonly platform?: NodeJS.Platform;
  readonly architecture?: string;
  readonly now?: Date;
  readonly clock?: () => Date;
  readonly runtimeManager?: DaemonRuntimeBoundary;
  readonly automationRuntime?: DaemonAutomationBoundary;
  readonly automationKeySource?: ConstructorParameters<
    typeof EncryptedFileAutomationRepository
  >[1];
  readonly profile?: (dataDirectory: string) => Promise<unknown>;
  readonly inspect?: (
    selectedPath: string,
    signal: AbortSignal
  ) => Promise<{ inspection: unknown }>;
  readonly catalogLoader?: (
    target: ModelTarget,
    now: Date | undefined
  ) => SignedModelCatalog;
  readonly downloadTransport?: ModelDownloadTransport;
  readonly activationSource?: ManagedRuntimeActivationSource;
  readonly installBoundaryFactory?: (
    options: DaemonInstallBoundaryFactoryOptions
  ) => DaemonModelInstallBoundary;
}

export interface DaemonInstallBoundaryFactoryOptions {
  readonly rootDirectory: string;
  readonly target: ModelTarget;
  readonly catalog: SignedModelCatalog;
  readonly downloadTransport?: ModelDownloadTransport;
  readonly currentTime: () => Date;
}

export interface DaemonDispatcher {
  dispatch(request: DaemonWorkRequest, signal: AbortSignal): Promise<unknown>;
  shutdown(): Promise<void>;
}

export function createDaemonDispatcher(
  options: CreateDaemonDispatcherOptions
): DaemonDispatcher {
  const dataDirectory = resolveTrustedDataDirectory(options.dataDirectory);
  let runtimeManager = options.runtimeManager;
  const currentTime = options.clock ??
    (() => options.now ?? new Date());
  const target = currentManagedModelTarget(
    options.platform ?? process.platform,
    options.architecture ?? process.arch
  );

  let installBoundary: DaemonModelInstallBoundary | null = null;
  let installUnavailableError: RuntimeBoundaryError | null = null;
  if (target === null) {
    installUnavailableError = unavailableTarget();
  } else {
    try {
      const catalog = (
        options.catalogLoader ??
        ((selectedTarget, now) => loadStaticBetaModelCatalog({
          target: selectedTarget,
          ...(now === undefined ? {} : { now })
        }))
      )(target, currentTime());
      const factoryOptions = {
        rootDirectory: path.join(dataDirectory, MANAGED_MODEL_DIRECTORY),
        target,
        catalog,
        currentTime,
        ...(options.downloadTransport === undefined
          ? {}
          : { downloadTransport: options.downloadTransport })
      };
      if (options.installBoundaryFactory !== undefined) {
        installBoundary = options.installBoundaryFactory(factoryOptions);
      } else {
        const stack = createManagedStack({
          ...factoryOptions,
          activationSource:
            options.activationSource ??
            new UnavailableManagedRuntimeActivationSource()
        });
        installBoundary = stack.installBoundary;
        runtimeManager ??= stack.runtimeManager;
      }
    } catch (error) {
      installUnavailableError = unavailableCatalog(error);
    }
  }

  return createDispatcherFromDependencies({
    dataDirectory,
    runtimeManager: runtimeManager ?? new LocalRuntimeManager(),
    ...(options.automationRuntime === undefined
      ? {}
      : { automationRuntime: options.automationRuntime }),
    ...(options.automationKeySource === undefined
      ? {}
      : { automationKeySource: options.automationKeySource }),
    installBoundary,
    installUnavailableError,
    profile: options.profile ?? profileHardware,
    inspect: options.inspect ?? inspectGguf
  });
}

export function createDispatcherFromDependencies(
  dependencies: DaemonDispatcherDependencies
): DaemonDispatcher {
  const dataDirectory = resolveTrustedDataDirectory(
    dependencies.dataDirectory
  );
  let activeInspectionRequestId: string | null = null;
  let accepting = true;
  let shutdownPromise: Promise<void> | null = null;
  const automationRuntime = dependencies.automationRuntime ??
    new AutomationRuntime({
      dataDirectory,
      runtime: dependencies.runtimeManager,
      ...(dependencies.automationKeySource === undefined
        ? {}
        : {
            repository: new EncryptedFileAutomationRepository(
              dataDirectory,
              dependencies.automationKeySource
            )
          })
    });

  const requireInstallBoundary = (): DaemonModelInstallBoundary => {
    if (dependencies.installBoundary !== null) {
      return dependencies.installBoundary;
    }
    throw cloneBoundaryError(
      dependencies.installUnavailableError ?? unavailableTarget()
    );
  };

  return {
    async dispatch(
      request: DaemonWorkRequest,
      signal: AbortSignal
    ): Promise<unknown> {
      if (!accepting) {
        throw new RuntimeBoundaryError({
          code: "RUNTIME_UNAVAILABLE",
          message: "The isolated local service is shutting down.",
          retryable: false
        });
      }
      switch (request.type) {
        case "system.profile":
          return HardwareProfileSchema.parse(
            await dependencies.profile(dataDirectory)
          );
        case "runtime.discover":
          return z.array(RuntimeDescriptorSchema).parse(
            await dependencies.runtimeManager.discover()
          );
        case "runtime.chat": {
          const cancel = () => {
            dependencies.runtimeManager.cancel(request.payload.operationId);
          };
          signal.addEventListener("abort", cancel, { once: true });
          try {
            return await dependencies.runtimeManager.chat(request.payload);
          } finally {
            signal.removeEventListener("abort", cancel);
          }
        }
        case "runtime.cancel":
          return {
            cancelled: dependencies.runtimeManager.cancel(
              request.payload.operationId
            )
          };
        case "automation.snapshot":
          return AutomationWorkspaceSnapshotSchema.parse(
            await automationRuntime.snapshot()
          );
        case "automation.agent.save":
          return AutomationAgentSchema.parse(
            await automationRuntime.saveAgent(request.payload)
          );
        case "automation.workflow.save":
          return AutomationWorkflowSchema.parse(
            await automationRuntime.saveWorkflow(request.payload)
          );
        case "automation.memory.save":
          return AutomationMemoryDocumentSchema.parse(
            await automationRuntime.saveMemory(request.payload)
          );
        case "automation.source.save":
          return AutomationSourceDocumentSchema.parse(
            await automationRuntime.saveSource(request.payload)
          );
        case "automation.artifact.review":
          return AutomationArtifactSchema.parse(
            await automationRuntime.reviewArtifact(request.payload)
          );
        case "automation.connector.ensure-local":
          return AutomationConnectorSchema.parse(
            await automationRuntime.ensureLocalConnector(request.payload)
          );
        case "automation.pack.export":
          return AutomationWorkflowPackSchema.parse(
            await automationRuntime.exportPack(request.payload.workflowId)
          );
        case "automation.pack.import":
          return AutomationWorkflowSchema.parse(
            await automationRuntime.importPack(request.payload)
          );
        case "automation.dry-run":
          return AutomationDryRunSchema.parse(
            await automationRuntime.dryRun(request.payload.workflowId)
          );
        case "automation.folder-changed":
          await automationRuntime.folderChanged(request.payload.root);
          return { started: true };
        case "automation.run.start":
          return AutomationRunSnapshotSchema.parse(
            await automationRuntime.start(request.payload)
          );
        case "automation.run.action":
          return AutomationRunSnapshotSchema.parse(
            await automationRuntime.action(request.payload)
          );
        case "model.recommend": {
          const profile = HardwareProfileSchema.parse(
            await dependencies.profile(dataDirectory)
          );
          return ConciergeSnapshotSchema.parse({
            profile,
            catalogReviewedAt: STARTER_CATALOG_REVIEWED_AT,
            recommendations: rankOpenWeightModels(
              profile,
              STARTER_OPEN_WEIGHT_CATALOG,
              request.payload.mode ?? profile.recommendation
            )
          });
        }
        case "model.inspect": {
          if (activeInspectionRequestId !== null) {
            throw new RuntimeBoundaryError({
              code: "BUSY",
              message: "Another model file is already being inspected.",
              retryable: true
            });
          }
          activeInspectionRequestId = request.requestId;
          try {
            const result = await dependencies.inspect(
              request.payload.selectedPath,
              signal
            );
            return GgufInspectionSchema.parse(result.inspection);
          } finally {
            activeInspectionRequestId = null;
          }
        }
        case "model.install.snapshot":
          return ModelInstallSnapshotSchema.parse(
            await requireInstallBoundary().snapshot()
          );
        case "model.license.review":
          return ModelLicenseReviewSchema.parse(
            await requireInstallBoundary().review(request.payload.modelId)
          );
        case "model.license.acknowledge":
          return LicenseAcknowledgementSchema.parse(
            await requireInstallBoundary().acknowledge(request.payload)
          );
        case "model.install.start":
          return ModelInstallStatusSchema.parse(
            await requireInstallBoundary().start(
              request.payload.modelId,
              signal
            )
          );
        case "model.install.cancel":
          return ModelInstallCancelResultSchema.parse(
            await requireInstallBoundary().cancel(
              request.payload.operationId
            )
          );
      }
    },
    shutdown(): Promise<void> {
      if (shutdownPromise !== null) {
        return shutdownPromise;
      }
      accepting = false;
      shutdownPromise = (async () => {
        await automationRuntime.shutdown();
        await dependencies.runtimeManager.shutdown();
      })();
      return shutdownPromise;
    }
  };
}

export function resolveTrustedDataDirectory(value: string): string {
  if (typeof value !== "string" || value.trim() === "" || value.includes("\0")) {
    throw invalidDataDirectory();
  }
  if (!path.isAbsolute(value)) {
    throw invalidDataDirectory();
  }
  const resolved = path.resolve(value);
  if (resolved === path.parse(resolved).root) {
    throw invalidDataDirectory();
  }
  return resolved;
}

export function toRendererSafeDaemonError(
  error: unknown,
  requestType: DaemonWorkRequest["type"]
): DesktopError {
  const detail = toDesktopError(error);
  const parsed = DesktopErrorSchema.safeParse(detail);
  if (!parsed.success) {
    return {
      code: "UNKNOWN",
      message: isModelInstallRoute(requestType)
        ? "The managed model operation failed inside the isolated service."
        : "A local component failed inside the isolated service.",
      retryable: false
    };
  }
  if (
    isModelInstallRoute(requestType) &&
    parsed.data.code === "UNKNOWN"
  ) {
    return {
      code: "UNKNOWN",
      message: "The managed model operation failed inside the isolated service.",
      retryable: false
    };
  }
  return parsed.data;
}

interface ManagedStackOptions extends DaemonInstallBoundaryFactoryOptions {
  readonly activationSource: ManagedRuntimeActivationSource;
}

function createManagedStack(options: ManagedStackOptions): {
  readonly installBoundary: ModelInstallController;
  readonly runtimeManager: LocalRuntimeManager;
} {
  const catalogSource = Object.freeze({
    currentCatalog: () => {
      assertCatalogCurrent(options.catalog, options.currentTime);
      return options.catalog;
    }
  });
  const store = new FileLicenseAcknowledgementStore({
    rootDirectory: options.rootDirectory
  });
  const licenseService = new ModelLicenseService({
    catalogSource,
    store
  });
  const installer = new ManagedModelInstaller({
    rootDirectory: options.rootDirectory,
    ...(options.downloadTransport === undefined
      ? {}
      : { transport: options.downloadTransport }),
    redirectPolicy: MANAGED_MODEL_DOWNLOAD_REDIRECT_POLICY
  });
  const installController = new ModelInstallController({
    catalogSource,
    licenseService,
    installer,
    target: options.target
  });
  const lane = new SingleLaneScheduler();
  const supervisor = new LlamaServerSupervisor({
    operationLane: lane
  });
  const managedAdapter = new ManagedLlamaAdapter({
    lane,
    supervisor,
    catalogSource,
    installController,
    modelResolver: installer,
    activationSource: options.activationSource,
    target: options.target,
    now: options.currentTime
  });
  return {
    installBoundary: installController,
    runtimeManager: new LocalRuntimeManager([
      new OllamaAdapter(),
      new LmStudioAdapter(
        undefined,
        process.env.CADRANE_LOCAL_API_KEY
      ),
      managedAdapter
    ], lane)
  };
}

function assertCatalogCurrent(
  catalog: SignedModelCatalog,
  currentTime: () => Date
): void {
  let nowMs = Number.NaN;
  try {
    nowMs = currentTime().getTime();
  } catch {
    // The fail-closed branch below owns the renderer-safe error.
  }
  const issuedAtMs = Date.parse(catalog.body.issuedAt);
  const expiresAtMs = Date.parse(catalog.body.expiresAt);
  if (
    !Number.isFinite(nowMs) ||
    !Number.isFinite(issuedAtMs) ||
    !Number.isFinite(expiresAtMs) ||
    nowMs < issuedAtMs - 5 * 60_000 ||
    nowMs >= expiresAtMs
  ) {
    throw new RuntimeBoundaryError({
      code: "CATALOG_INVALID",
      message: "The signed model catalog is not currently valid.",
      retryable: false
    });
  }
}

function currentManagedModelTarget(
  platform: NodeJS.Platform,
  architecture: string
): ModelTarget | null {
  return platform === "darwin" && architecture === "arm64"
    ? "darwin-arm64"
    : null;
}

function unavailableTarget(): RuntimeBoundaryError {
  return new RuntimeBoundaryError({
    code: "RUNTIME_UNAVAILABLE",
    message:
      "Managed model installation is not yet verified for this computer target.",
    retryable: false
  });
}

function unavailableCatalog(error: unknown): RuntimeBoundaryError {
  if (
    error instanceof RuntimeBoundaryError &&
    error.detail.code === "CATALOG_INVALID"
  ) {
    return new RuntimeBoundaryError({
      code: "CATALOG_INVALID",
      message: "The signed model catalog is not currently valid.",
      retryable: false
    });
  }
  return new RuntimeBoundaryError({
    code: "CATALOG_INVALID",
    message: "The signed model catalog could not be activated.",
    retryable: false
  }, { cause: error });
}

function invalidDataDirectory(): RuntimeBoundaryError {
  return new RuntimeBoundaryError({
    code: "SECURITY_BOUNDARY",
    message: "The trusted Rellane data directory is invalid.",
    retryable: false
  });
}

function cloneBoundaryError(error: RuntimeBoundaryError): RuntimeBoundaryError {
  return new RuntimeBoundaryError({ ...error.detail });
}

function isModelInstallRoute(
  type: DaemonWorkRequest["type"]
): boolean {
  return type === "model.install.snapshot" ||
    type === "model.license.review" ||
    type === "model.license.acknowledge" ||
    type === "model.install.start" ||
    type === "model.install.cancel";
}
