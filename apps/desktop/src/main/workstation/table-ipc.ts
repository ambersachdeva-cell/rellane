import type { IpcMainInvokeEvent } from "electron";
import { ipcMain } from "electron";
import { z } from "zod";
import { IPC_CHANNELS } from "../../shared/ipc-channels.js";
import { createAgentSourceOwners } from "../agents/source-owner.js";
import { parseTable, type ParsedTable } from "./table-parse.js";
import { runQuery, type Filter, type QueryResult, type QuerySpec } from "./table-query.js";

export const WorkstationTableParseInputSchema = z.object({
  caseId: z.string().min(1).max(500),
  sourceTurnId: z.string().min(1).max(500)
});

export const QueryFilterSchema = z.object({
  column: z.number().int().nonnegative(),
  op: z.enum(["is", "is-not", "contains", "gt", "lt", "between", "empty", "not-empty"]),
  value: z.string().max(10_000),
  value2: z.string().max(10_000).optional()
});

export const QuerySortSchema = z.object({
  column: z.number().int().nonnegative(),
  direction: z.enum(["asc", "desc"])
});

export const QueryAggregateSchema = z.object({
  column: z.number().int().nonnegative(),
  fn: z.enum(["sum", "count", "avg", "min", "max"])
});

export const QuerySpecSchema = z.object({
  filters: z.array(QueryFilterSchema).max(100),
  sort: QuerySortSchema.optional(),
  groupBy: z.number().int().nonnegative().optional(),
  aggregate: QueryAggregateSchema.optional(),
  limit: z.number().int().nonnegative().max(100_000).optional()
});

export const WorkstationTableQueryInputSchema = z.union([
  z.object({
    caseId: z.string().min(1).max(500),
    sourceTurnId: z.string().min(1).max(500),
    spec: QuerySpecSchema
  }),
  z.object({
    caseId: z.string().min(1).max(500),
    sourceTurnId: z.string().min(1).max(500),
    query: QuerySpecSchema
  }),
  z.object({
    caseId: z.string().min(1).max(500),
    sourceTurnId: z.string().min(1).max(500),
    querySpec: QuerySpecSchema
  }),
  z.object({
    caseId: z.string().min(1).max(500),
    sourceTurnId: z.string().min(1).max(500),
    filters: z.array(QueryFilterSchema).max(100),
    sort: QuerySortSchema.optional(),
    groupBy: z.number().int().nonnegative().optional(),
    aggregate: QueryAggregateSchema.optional(),
    limit: z.number().int().nonnegative().max(100_000).optional()
  })
]);

export interface TableQueryRequest {
  readonly caseId: string;
  readonly sourceTurnId: string;
  readonly spec: QuerySpec;
}

export function parseQueryRequest(input: unknown): TableQueryRequest {
  const parsed = WorkstationTableQueryInputSchema.parse(input);

  let caseId: string;
  let sourceTurnId: string;
  let rawSpec: z.infer<typeof QuerySpecSchema>;

  if ("spec" in parsed) {
    caseId = parsed.caseId;
    sourceTurnId = parsed.sourceTurnId;
    rawSpec = parsed.spec;
  } else if ("query" in parsed) {
    caseId = parsed.caseId;
    sourceTurnId = parsed.sourceTurnId;
    rawSpec = parsed.query;
  } else if ("querySpec" in parsed) {
    caseId = parsed.caseId;
    sourceTurnId = parsed.sourceTurnId;
    rawSpec = parsed.querySpec;
  } else {
    caseId = parsed.caseId;
    sourceTurnId = parsed.sourceTurnId;
    rawSpec = {
      filters: parsed.filters,
      ...(parsed.sort !== undefined ? { sort: parsed.sort } : {}),
      ...(parsed.groupBy !== undefined ? { groupBy: parsed.groupBy } : {}),
      ...(parsed.aggregate !== undefined ? { aggregate: parsed.aggregate } : {}),
      ...(parsed.limit !== undefined ? { limit: parsed.limit } : {})
    };
  }

  const filters: Filter[] = [];
  for (let i = 0; i < rawSpec.filters.length; i++) {
    const f = rawSpec.filters[i]!;
    const filter: Filter = {
      column: f.column,
      op: f.op,
      value: f.value,
      ...(f.value2 !== undefined ? { value2: f.value2 } : {})
    };
    filters.push(filter);
  }

  const spec: QuerySpec = {
    filters,
    ...(rawSpec.sort !== undefined ? { sort: { column: rawSpec.sort.column, direction: rawSpec.sort.direction } } : {}),
    ...(rawSpec.groupBy !== undefined ? { groupBy: rawSpec.groupBy } : {}),
    ...(rawSpec.aggregate !== undefined
      ? { aggregate: { column: rawSpec.aggregate.column, fn: rawSpec.aggregate.fn } }
      : {}),
    ...(rawSpec.limit !== undefined ? { limit: rawSpec.limit } : {})
  };

  return {
    caseId,
    sourceTurnId,
    spec
  };
}

export interface InstallWorkstationTableOptions {
  readonly assertTrusted: (event: IpcMainInvokeEvent) => void;
  readonly sourceText: (caseId: string, sourceTurnId: string) => Promise<string | null>;
}

export function installWorkstationTable(options: InstallWorkstationTableOptions): void {
  const owners = createAgentSourceOwners(() => {});
  const ownerFor = (event: IpcMainInvokeEvent) => owners(event.sender, event.senderFrame);
  let inFlight = false;

  ipcMain.handle(IPC_CHANNELS.workstationTableParse, async (event, input: unknown): Promise<ParsedTable> => {
    options.assertTrusted(event);
    const owner = ownerFor(event);

    if (inFlight) {
      throw new Error("A table operation is already running. Wait for it to finish.");
    }

    const request = WorkstationTableParseInputSchema.parse(input);

    inFlight = true;
    try {
      const text = await options.sourceText(request.caseId, request.sourceTurnId);
      if (text === null) {
        throw new Error(`Source turn ${request.sourceTurnId} was not found in this work.`);
      }

      const result = parseTable(text);

      options.assertTrusted(event);
      if (ownerFor(event) !== owner) {
        throw new Error("This window changed while reading the table.");
      }

      return result;
    } finally {
      inFlight = false;
    }
  });

  ipcMain.handle(IPC_CHANNELS.workstationTableQuery, async (event, input: unknown): Promise<QueryResult> => {
    options.assertTrusted(event);
    const owner = ownerFor(event);

    if (inFlight) {
      throw new Error("A table operation is already running. Wait for it to finish.");
    }

    const request = parseQueryRequest(input);

    inFlight = true;
    try {
      const text = await options.sourceText(request.caseId, request.sourceTurnId);
      if (text === null) {
        throw new Error(`Source turn ${request.sourceTurnId} was not found in this work.`);
      }

      // Sources can change between invocations, so re-parsing from source ensures results are never stale
      const table = parseTable(text);
      const result = runQuery(table, request.spec);

      options.assertTrusted(event);
      if (ownerFor(event) !== owner) {
        throw new Error("This window changed while querying the table.");
      }

      return result;
    } finally {
      inFlight = false;
    }
  });
}
