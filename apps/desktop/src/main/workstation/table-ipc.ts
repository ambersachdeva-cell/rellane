import type { IpcMainInvokeEvent } from "electron";
import { ipcMain } from "electron";
import { z } from "zod";
import { IPC_CHANNELS } from "../../shared/ipc-channels.js";
import { createAgentSourceOwners } from "../agents/source-owner.js";
import { parseTable, type ParsedTable } from "./table-parse.js";
import { runQuery, type Filter, type QueryResult as TableQueryResult, type QuerySpec } from "./table-query.js";
import {
  createTabularWorkbench,
  type ColumnSchema,
  type ColumnStats,
  type QueryResult,
  type TabularWorkbench
} from "./duckdb-workbench.js";
import {
  evaluateFormula,
  transformTabularData,
  type SandboxResult
} from "./wasm-sandbox.js";

export const MAX_IPC_PAYLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_PATH_LENGTH = 4096;

export const WorkstationTableParseInputSchema = z.object({
  caseId: z.string().min(1).max(500),
  sourceTurnId: z.string().min(1).max(500),
  sql: z.string().min(1).optional(),
  formula: z.string().min(1).optional(),
  formulaVariables: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])).optional(),
  transformCode: z.string().min(1).optional(),
  includeWorkbenchStats: z.boolean().optional()
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

export const WorkstationTableReadInputSchema = z.object({
  caseId: z.string().min(1).max(500).optional(),
  sourceTurnId: z.string().min(1).max(500).optional(),
  path: z.string().min(1).max(MAX_PATH_LENGTH).optional(),
  filePath: z.string().min(1).max(MAX_PATH_LENGTH).optional(),
  sql: z.string().min(1).optional(),
  formula: z.string().min(1).optional(),
  formulaVariables: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])).optional(),
  transformCode: z.string().min(1).optional(),
  includeWorkbenchStats: z.boolean().optional()
});

export const TableReadInputSchema = WorkstationTableReadInputSchema;

export const WorkstationTableExportInputSchema = z.object({
  caseId: z.string().min(1).max(500).optional(),
  sourceTurnId: z.string().min(1).max(500).optional(),
  path: z.string().min(1).max(MAX_PATH_LENGTH).optional(),
  filePath: z.string().min(1).max(MAX_PATH_LENGTH).optional(),
  content: z.string().max(MAX_IPC_PAYLOAD_BYTES).optional(),
  format: z.string().optional(),
  data: z.unknown().optional()
});

export const TableExportInputSchema = WorkstationTableExportInputSchema;

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

export interface LoadedTableColumn {
  readonly name: string;
  readonly type?: string | undefined;
}

export interface LoadedTable {
  readonly columns: readonly LoadedTableColumn[];
  readonly rows: readonly (readonly unknown[])[];
}

export interface TableWorkbenchAnalysis {
  readonly workbenchStats?: readonly ColumnStats[];
  readonly sqlResult?: QueryResult;
  readonly formulaResult?: SandboxResult;
  readonly transformResult?: {
    readonly success: boolean;
    readonly records?: readonly Record<string, unknown>[];
    readonly error?: string;
  };
}

export function analyzeLoadedTableWithWorkbench(
  table: LoadedTable,
  options?: {
    sql?: string | undefined;
    formula?: string | undefined;
    formulaVariables?: Record<string, number | string | boolean> | undefined;
    transformCode?: string | undefined;
    includeWorkbenchStats?: boolean | undefined;
  }
): TableWorkbenchAnalysis {
  const records: Record<string, unknown>[] = [];
  const cols = table.columns;
  const rows = table.rows;

  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    const record: Record<string, unknown> = {};
    if (Array.isArray(row)) {
      for (let c = 0; c < cols.length; c++) {
        const col = cols[c];
        const colName =
          typeof col === "string"
            ? col
            : col && typeof col.name === "string"
              ? col.name
              : `col_${c}`;
        record[colName] = row[c];
      }
    }
    records.push(record);
  }

  const workbench: TabularWorkbench = createTabularWorkbench();
  workbench.createTableFromRecords("data", records);

  const analysis: {
    workbenchStats?: readonly ColumnStats[];
    sqlResult?: QueryResult;
    formulaResult?: SandboxResult;
    transformResult?: {
      readonly success: boolean;
      readonly records?: readonly Record<string, unknown>[];
      readonly error?: string;
    };
  } = {};

  if (options?.includeWorkbenchStats === true) {
    analysis.workbenchStats = workbench.calculateStats("data");
  }
  if (options?.sql !== undefined) {
    analysis.sqlResult = workbench.execute(options.sql);
  }
  if (options?.formula !== undefined) {
    analysis.formulaResult = evaluateFormula(options.formula, {
      variables: options.formulaVariables ?? {},
      tables: { data: table.rows }
    });
  }
  if (options?.transformCode !== undefined) {
    analysis.transformResult = transformTabularData(records, options.transformCode);
  }

  return analysis;
}

export interface InstallWorkstationTableOptions {
  readonly assertTrusted: (event: IpcMainInvokeEvent) => void;
  readonly sourceText: (caseId: string, sourceTurnId: string) => Promise<string | null>;
}

export function installWorkstationTable(options: InstallWorkstationTableOptions): void {
  const owners = createAgentSourceOwners(() => {});
  const ownerFor = (event: IpcMainInvokeEvent) => owners(event.sender, event.senderFrame);
  let inFlight = false;

  ipcMain.handle(
    IPC_CHANNELS.workstationTableParse,
    async (event, input: unknown): Promise<ParsedTable & TableWorkbenchAnalysis> => {
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

        if (
          request.sql !== undefined ||
          request.formula !== undefined ||
          request.transformCode !== undefined ||
          request.includeWorkbenchStats !== undefined
        ) {
          const analysis = analyzeLoadedTableWithWorkbench(result, request);
          return {
            ...result,
            ...analysis
          };
        }

        return result;
      } finally {
        inFlight = false;
      }
    }
  );

  ipcMain.handle(IPC_CHANNELS.workstationTableQuery, async (event, input: unknown): Promise<TableQueryResult> => {
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

export { createTabularWorkbench, evaluateFormula, transformTabularData };
export type { ColumnSchema, ColumnStats, QueryResult, SandboxResult, TabularWorkbench };
