import {
  REQUIRED_HOST_WRITERS,
  type RequiredHostWriterId,
  RecoveryQuiescenceCoordinator,
  RecoveryQuiescenceError,
  type RecoveryQuiescenceCoordinatorOptions,
  type WriterPermit,
  type AcquireWriterPermitResult,
} from "./recovery-quiescence.js";

export {
  REQUIRED_HOST_WRITERS,
  type RequiredHostWriterId,
  RecoveryQuiescenceCoordinator,
  RecoveryQuiescenceError,
  type RecoveryQuiescenceCoordinatorOptions,
  type WriterPermit,
  type AcquireWriterPermitResult,
};

/**
 * Creates a RecoveryQuiescenceCoordinator pre-configured with all 14 REQUIRED_HOST_WRITERS
 * and an explicit "trusted" coverage declaration.
 */
export function createTrustedHostQuiescenceCoordinator(
  options?: RecoveryQuiescenceCoordinatorOptions
): RecoveryQuiescenceCoordinator {
  const coordinator = new RecoveryQuiescenceCoordinator(options);
  for (const writerId of REQUIRED_HOST_WRITERS) {
    coordinator.registerWriter(writerId);
  }
  coordinator.setCoverageDeclaration("trusted");
  return coordinator;
}

/**
 * Synchronously acquires a writer permit from the coordinator, executes fn(),
 * and releases the permit in a finally block.
 */
export function withHostWriterPermitSync<T>(
  coordinator: RecoveryQuiescenceCoordinator,
  writerId: RequiredHostWriterId,
  fn: () => T
): T {
  const permit = coordinator.acquireWriterPermit(writerId);
  try {
    return fn();
  } finally {
    permit.release();
  }
}

/**
 * Acquires a writer permit synchronously before awaiting fn(), and releases
 * the permit in a finally block.
 */
export async function withHostWriterPermit<T>(
  coordinator: RecoveryQuiescenceCoordinator,
  writerId: RequiredHostWriterId,
  fn: () => Promise<T> | T
): Promise<T> {
  const permit = coordinator.acquireWriterPermit(writerId);
  try {
    return await fn();
  } finally {
    permit.release();
  }
}

/**
 * Domain-specific writer gate interface providing permit-scoped execution helpers.
 */
export interface HostDomainWriterGate {
  /**
   * Executes an asynchronous or synchronous callback within an acquired writer permit.
   */
  <T>(fn: () => Promise<T> | T): Promise<T>;

  /**
   * The registered Host writer ID for this domain helper.
   */
  readonly writerId: RequiredHostWriterId;

  /**
   * Directly acquires a writer permit synchronously.
   * Callers must release the permit when finished.
   */
  acquire(): WriterPermit;

  /**
   * Attempts to acquire a writer permit without throwing if frozen.
   */
  tryAcquire(): AcquireWriterPermitResult;

  /**
   * Executes an asynchronous or synchronous callback within an acquired writer permit.
   */
  run<T>(fn: () => Promise<T> | T): Promise<T>;

  /**
   * Executes a synchronous callback within an acquired writer permit.
   */
  runSync<T>(fn: () => T): T;

  /**
   * Alias for runSync.
   */
  sync<T>(fn: () => T): T;

  /**
   * Alias for run.
   */
  withPermit<T>(fn: () => Promise<T> | T): Promise<T>;

  /**
   * Alias for runSync.
   */
  withPermitSync<T>(fn: () => T): T;
}

/**
 * Typed registry of all 14 Host domain writer gates.
 */
export interface HostWriterRegistry {
  readonly book: HostDomainWriterGate;
  readonly workstationCase: HostDomainWriterGate;
  readonly workstationBrief: HostDomainWriterGate;
  readonly workstationAgent: HostDomainWriterGate;
  readonly restoreLease: HostDomainWriterGate;
  readonly sessionPool: HostDomainWriterGate;
  readonly timeline: HostDomainWriterGate;
  readonly preimages: HostDomainWriterGate;
  readonly agents: HostDomainWriterGate;
  readonly memory: HostDomainWriterGate;
  readonly watches: HostDomainWriterGate;
  readonly settings: HostDomainWriterGate;
  readonly secrets: HostDomainWriterGate;
  readonly automations: HostDomainWriterGate;
}

/**
 * Full Host writer gate interface extending HostWriterRegistry with coordinator access
 * and generalized helper methods.
 */
export interface HostWriterGate extends HostWriterRegistry {
  readonly coordinator: RecoveryQuiescenceCoordinator;
  forWriter(writerId: RequiredHostWriterId): HostDomainWriterGate;
  withPermit<T>(writerId: RequiredHostWriterId, fn: () => Promise<T> | T): Promise<T>;
  withPermitSync<T>(writerId: RequiredHostWriterId, fn: () => T): T;
}

function createDomainWriterGate(
  coordinator: RecoveryQuiescenceCoordinator,
  writerId: RequiredHostWriterId
): HostDomainWriterGate {
  const run = <T>(fn: () => Promise<T> | T): Promise<T> => {
    return withHostWriterPermit(coordinator, writerId, fn);
  };

  const runSync = <T>(fn: () => T): T => {
    return withHostWriterPermitSync(coordinator, writerId, fn);
  };

  const acquire = (): WriterPermit => {
    return coordinator.acquireWriterPermit(writerId);
  };

  const tryAcquire = (): AcquireWriterPermitResult => {
    return coordinator.tryAcquireWriterPermit(writerId);
  };

  const fnCallable = <T>(fn: () => Promise<T> | T): Promise<T> => {
    return run(fn);
  };

  return Object.assign(fnCallable, {
    writerId,
    acquire,
    tryAcquire,
    run,
    runSync,
    sync: runSync,
    withPermit: run,
    withPermitSync: runSync,
  });
}

/**
 * Creates a HostWriterGate providing typed access across all 14 Host writer domains.
 */
export function createHostWriterGate(
  coordinator: RecoveryQuiescenceCoordinator = createTrustedHostQuiescenceCoordinator()
): HostWriterGate {
  const bookGate = createDomainWriterGate(coordinator, "book");
  const caseGate = createDomainWriterGate(coordinator, "workstation-case");
  const briefGate = createDomainWriterGate(coordinator, "workstation-brief");
  const agentGate = createDomainWriterGate(coordinator, "workstation-agent");
  const restoreLeaseGate = createDomainWriterGate(coordinator, "restore-lease");
  const sessionPoolGate = createDomainWriterGate(coordinator, "session-pool");
  const timelineGate = createDomainWriterGate(coordinator, "timeline");
  const preimagesGate = createDomainWriterGate(coordinator, "preimages");
  const agentsGate = createDomainWriterGate(coordinator, "agents");
  const memoryGate = createDomainWriterGate(coordinator, "memory");
  const watchesGate = createDomainWriterGate(coordinator, "watches");
  const settingsGate = createDomainWriterGate(coordinator, "settings");
  const secretsGate = createDomainWriterGate(coordinator, "secrets");
  const automationsGate = createDomainWriterGate(coordinator, "automations");

  const writerMap: Record<RequiredHostWriterId, HostDomainWriterGate> = {
    book: bookGate,
    "workstation-case": caseGate,
    "workstation-brief": briefGate,
    "workstation-agent": agentGate,
    "restore-lease": restoreLeaseGate,
    "session-pool": sessionPoolGate,
    timeline: timelineGate,
    preimages: preimagesGate,
    agents: agentsGate,
    memory: memoryGate,
    watches: watchesGate,
    settings: settingsGate,
    secrets: secretsGate,
    automations: automationsGate,
  };

  return {
    book: bookGate,
    workstationCase: caseGate,
    workstationBrief: briefGate,
    workstationAgent: agentGate,
    restoreLease: restoreLeaseGate,
    sessionPool: sessionPoolGate,
    timeline: timelineGate,
    preimages: preimagesGate,
    agents: agentsGate,
    memory: memoryGate,
    watches: watchesGate,
    settings: settingsGate,
    secrets: secretsGate,
    automations: automationsGate,
    coordinator,
    forWriter(writerId: RequiredHostWriterId): HostDomainWriterGate {
      const gate = writerMap[writerId];
      if (!gate) {
        throw new Error(`Unknown host writer: ${String(writerId)}`);
      }
      return gate;
    },
    withPermit<T>(writerId: RequiredHostWriterId, fn: () => Promise<T> | T): Promise<T> {
      return withHostWriterPermit(coordinator, writerId, fn);
    },
    withPermitSync<T>(writerId: RequiredHostWriterId, fn: () => T): T {
      return withHostWriterPermitSync(coordinator, writerId, fn);
    },
  };
}

export const createHostWriterRegistry = createHostWriterGate;
