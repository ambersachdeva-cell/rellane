const PORT_QUEUES = new WeakMap<object, Promise<void>>();

/** Shared private whole-operation queue for all transactional encrypted coordinators. */
export async function enqueueTransactionalPortOperation<T>(identity: object, operation: () => Promise<T>): Promise<T> {
  const prior = PORT_QUEUES.get(identity) ?? Promise.resolve(); let release: (() => void) | undefined;
  const completion = new Promise<void>((resolve) => { release = resolve; }); const entry = prior.then(() => completion); PORT_QUEUES.set(identity, entry);
  try { await prior; return await operation(); }
  finally { release?.(); if (PORT_QUEUES.get(identity) === entry) PORT_QUEUES.delete(identity); }
}
