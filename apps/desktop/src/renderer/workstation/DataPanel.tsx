/**
 * Interactive spreadsheet query and inspection dialog for CSV and tabular context.
 */
import {
  useState,
  useRef,
  type ReactNode,
  type FormEvent,
  type ChangeEvent,
} from "react";
import { Modal, Icon, IconButton } from "./ui.js";

export interface TableColumnLike {
  readonly name: string;
  readonly index: number;
  readonly type: string;
  readonly blanks?: number;
}

export interface ParsedTableLike {
  readonly columns: readonly TableColumnLike[];
  readonly rows: readonly (readonly string[])[];
  readonly rowCount?: number;
  readonly truncated?: boolean;
  readonly delimiter?: string;
  readonly problems?: readonly string[];
}

export type FilterOp =
  | "is"
  | "is-not"
  | "contains"
  | "gt"
  | "lt"
  | "between"
  | "empty"
  | "not-empty";

export interface FilterLike {
  readonly column: number;
  readonly op: FilterOp;
  readonly value: string;
  readonly value2?: string;
}

export interface QuerySortLike {
  readonly column: number;
  readonly direction: "asc" | "desc";
}

export type AggregateFunction = "sum" | "count" | "avg" | "min" | "max";

export interface QueryAggregateLike {
  readonly column: number;
  readonly fn: AggregateFunction;
}

export interface QuerySpecLike {
  readonly filters: readonly FilterLike[];
  readonly sort?: QuerySortLike;
  readonly groupBy?: number;
  readonly aggregate?: QueryAggregateLike;
  readonly limit?: number;
}

export interface QueryResultLike {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly string[])[];
  readonly matched: number;
  readonly total: number;
  readonly summary: string;
  readonly problems: readonly string[];
}

export interface DataPanelProps {
  readonly table: ParsedTableLike | null;
  readonly result: QueryResultLike | null;
  readonly onQuery: (spec: QuerySpecLike) => void;
  readonly onUseAsContext: (summary: string) => void;
  readonly onClose: () => void;
  readonly busy: boolean;
}

interface DraftFilter {
  readonly id: string;
  readonly column: number;
  readonly op: FilterOp;
  readonly value: string;
  readonly value2?: string;
}

interface OperatorOption {
  readonly op: FilterOp;
  readonly label: string;
}

// Capping rendered rows prevents DOM thrashing while retaining visibility of large imports
const MAX_DISPLAY_ROWS = 50;

function isNumericColumn(type: string): boolean {
  const t = type.toLowerCase();
  return (
    t === "number" ||
    t === "numeric" ||
    t === "integer" ||
    t === "float" ||
    t === "money" ||
    t === "currency"
  );
}

function isDateColumn(type: string): boolean {
  const t = type.toLowerCase();
  return t === "date" || t === "datetime" || t === "timestamp";
}

function isBooleanColumn(type: string): boolean {
  const t = type.toLowerCase();
  return t === "boolean" || t === "bool";
}

// Restricting operations to compatible types stops the owner querying text as numeric ranges
function getOperatorsForColumnType(type: string): readonly OperatorOption[] {
  if (isNumericColumn(type)) {
    return [
      { op: "is", label: "equals" },
      { op: "is-not", label: "does not equal" },
      { op: "gt", label: "greater than" },
      { op: "lt", label: "less than" },
      { op: "between", label: "between" },
      { op: "empty", label: "is empty" },
      { op: "not-empty", label: "is not empty" },
    ];
  }

  if (isDateColumn(type)) {
    return [
      { op: "is", label: "is on" },
      { op: "is-not", label: "is not on" },
      { op: "gt", label: "after" },
      { op: "lt", label: "before" },
      { op: "between", label: "between" },
      { op: "empty", label: "is empty" },
      { op: "not-empty", label: "is not empty" },
    ];
  }

  if (isBooleanColumn(type)) {
    return [
      { op: "is", label: "is" },
      { op: "is-not", label: "is not" },
      { op: "empty", label: "is empty" },
      { op: "not-empty", label: "is not empty" },
    ];
  }

  if (type.toLowerCase() === "empty") {
    return [
      { op: "empty", label: "is empty" },
      { op: "not-empty", label: "is not empty" },
    ];
  }

  return [
    { op: "contains", label: "contains" },
    { op: "is", label: "is exactly" },
    { op: "is-not", label: "is not" },
    { op: "empty", label: "is empty" },
    { op: "not-empty", label: "is not empty" },
  ];
}

function getColumnType(
  colName: string,
  colIndex: number,
  table: ParsedTableLike | null
): string {
  if (table !== null) {
    for (let i = 0; i < table.columns.length; i++) {
      const col = table.columns[i]!;
      if (col.name === colName) {
        return col.type;
      }
    }
    if (colIndex < table.columns.length) {
      return table.columns[colIndex]!.type;
    }
  }
  return "text";
}

// Right-aligning numbers follows standard accounting conventions for digit scanning
function getColumnAlignment(type: string): "right" | "left" {
  return isNumericColumn(type) ? "right" : "left";
}

function buildQuerySpec(
  filters: readonly DraftFilter[],
  sort: QuerySortLike | null,
  groupBy: number | null,
  aggregate: QueryAggregateLike | null
): QuerySpecLike {
  const activeFilters: FilterLike[] = [];
  for (let i = 0; i < filters.length; i++) {
    const f = filters[i];
    if (f === undefined) {
      continue;
    }

    if (f.op === "empty" || f.op === "not-empty") {
      activeFilters.push({
        column: f.column,
        op: f.op,
        value: "",
      });
    } else if (f.value.trim().length > 0) {
      // exactOptionalPropertyTypes requires omitting value2 entirely when not between
      if (
        f.op === "between" &&
        f.value2 !== undefined &&
        f.value2.trim().length > 0
      ) {
        activeFilters.push({
          column: f.column,
          op: f.op,
          value: f.value.trim(),
          value2: f.value2.trim(),
        });
      } else {
        activeFilters.push({
          column: f.column,
          op: f.op,
          value: f.value.trim(),
        });
      }
    }
  }

  const spec: QuerySpecLike = {
    filters: activeFilters,
    ...(sort !== null ? { sort } : {}),
    ...(groupBy !== null ? { groupBy } : {}),
    ...(aggregate !== null ? { aggregate } : {}),
  };

  return spec;
}

export function DataPanel({
  table,
  result,
  onQuery,
  onUseAsContext,
  onClose,
  busy,
}: DataPanelProps): ReactNode {
  const [filters, setFilters] = useState<readonly DraftFilter[]>([]);
  const [sortCol, setSortCol] = useState<number | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [groupByCol, setGroupByCol] = useState<number | null>(null);
  const [aggFn, setAggFn] = useState<AggregateFunction | null>(null);
  const [aggCol, setAggCol] = useState<number | null>(null);
  const filterIdCounter = useRef<number>(0);

  const totalRowCount = table !== null ? (table.rowCount ?? table.rows.length) : 0;
  const matchedRowCount = result !== null ? result.matched : totalRowCount;

  const summaryText =
    result !== null
      ? result.summary
      : `${totalRowCount.toLocaleString("en-GB")} of ${totalRowCount.toLocaleString(
          "en-GB"
        )} ${totalRowCount === 1 ? "row" : "rows"}.`;

  const tableProblems = table?.problems ?? [];
  const resultProblems = result?.problems ?? [];
  const allProblems: readonly string[] = [
    ...tableProblems,
    ...resultProblems.filter((p) => !tableProblems.includes(p)),
  ];

  const activeRows = result !== null ? result.rows : (table?.rows ?? []);
  const displayedRows = activeRows.slice(0, MAX_DISPLAY_ROWS);
  const remainingRowCount = activeRows.length - displayedRows.length;

  const columnsToRender: readonly string[] =
    result !== null
      ? result.columns
      : table !== null
      ? table.columns.map((c) => c.name)
      : [];

  const eligibleNumericColumns: readonly TableColumnLike[] =
    table !== null
      ? table.columns.filter((c) => isNumericColumn(c.type))
      : [];

  const aggregateConfig: QueryAggregateLike | null =
    aggFn !== null && (aggFn === "count" || aggCol !== null)
      ? {
          column: aggCol ?? 0,
          fn: aggFn,
        }
      : null;

  const handleAddFilter = () => {
    if (table === null || table.columns.length === 0) {
      return;
    }
    const firstCol = table.columns[0]!;
    const validOps = getOperatorsForColumnType(firstCol.type);
    const defaultOp = validOps[0]?.op ?? "is";

    filterIdCounter.current += 1;
    const newFilter: DraftFilter = {
      id: `filter-${filterIdCounter.current}`,
      column: firstCol.index,
      op: defaultOp,
      value: "",
    };
    setFilters((prev) => [...prev, newFilter]);
  };

  const handleRemoveFilter = (id: string) => {
    setFilters((prev) => prev.filter((f) => f.id !== id));
  };

  const handleFilterColumnChange = (id: string, colIndex: number) => {
    if (table === null) {
      return;
    }
    let selectedCol: TableColumnLike | undefined;
    for (let i = 0; i < table.columns.length; i++) {
      const col = table.columns[i]!;
      if (col.index === colIndex) {
        selectedCol = col;
        break;
      }
    }
    if (selectedCol === undefined) {
      return;
    }

    const allowedOps = getOperatorsForColumnType(selectedCol.type);
    setFilters((prev) =>
      prev.map((f) => {
        if (f.id !== id) {
          return f;
        }
        const isOpAllowed = allowedOps.some((o) => o.op === f.op);
        const nextOp = isOpAllowed ? f.op : (allowedOps[0]?.op ?? "is");
        return {
          id: f.id,
          column: colIndex,
          op: nextOp,
          value: "",
        };
      })
    );
  };

  const handleFilterOpChange = (id: string, op: FilterOp) => {
    setFilters((prev) =>
      prev.map((f) => {
        if (f.id !== id) {
          return f;
        }
        if (op === "between") {
          return {
            id: f.id,
            column: f.column,
            op,
            value: f.value,
            value2: "",
          };
        }
        return {
          id: f.id,
          column: f.column,
          op,
          value: f.value,
        };
      })
    );
  };

  const handleFilterValueChange = (id: string, value: string) => {
    setFilters((prev) =>
      prev.map((f) => {
        if (f.id !== id) {
          return f;
        }
        if (f.op === "between" && f.value2 !== undefined) {
          return {
            id: f.id,
            column: f.column,
            op: f.op,
            value,
            value2: f.value2,
          };
        }
        return {
          id: f.id,
          column: f.column,
          op: f.op,
          value,
        };
      })
    );
  };

  const handleFilterValue2Change = (id: string, value2: string) => {
    setFilters((prev) =>
      prev.map((f) => {
        if (f.id !== id) {
          return f;
        }
        return {
          id: f.id,
          column: f.column,
          op: f.op,
          value: f.value,
          value2,
        };
      })
    );
  };

  const handleHeaderClick = (colIndex: number) => {
    let nextCol: number | null = colIndex;
    let nextDir: "asc" | "desc" = "asc";

    if (sortCol === colIndex) {
      if (sortDir === "asc") {
        nextDir = "desc";
      } else {
        nextCol = null;
      }
    }

    setSortCol(nextCol);
    setSortDir(nextDir);

    const nextSort: QuerySortLike | null =
      nextCol !== null ? { column: nextCol, direction: nextDir } : null;
    const spec = buildQuerySpec(filters, nextSort, groupByCol, aggregateConfig);
    onQuery(spec);
  };

  const handleApplyQuery = (e?: FormEvent) => {
    if (e !== undefined) {
      e.preventDefault();
    }
    const nextSort: QuerySortLike | null =
      sortCol !== null ? { column: sortCol, direction: sortDir } : null;
    const spec = buildQuerySpec(filters, nextSort, groupByCol, aggregateConfig);
    onQuery(spec);
  };

  const handleReset = () => {
    setFilters([]);
    setSortCol(null);
    setSortDir("asc");
    setGroupByCol(null);
    setAggFn(null);
    setAggCol(null);
    onQuery({ filters: [] });
  };

  const handleUseAsContext = () => {
    if (result !== null) {
      onUseAsContext(result.summary);
    } else if (table !== null) {
      onUseAsContext(summaryText);
    }
  };

  return (
    <Modal
      title="Spreadsheet"
      eyebrow="Data query"
      onClose={onClose}
      wide={true}
    >
      <div className="ws-data-panel" aria-busy={busy}>
        <div className="ws-sr-only" role="status" aria-live="polite">
          {busy ? "Running query on spreadsheet..." : ""}
        </div>

        <div className="ws-data-summary-bar">
          <div className="ws-data-summary-details">
            <span className="ws-eyebrow">Answer</span>
            <p className="ws-data-summary-sentence">{summaryText}</p>
            <span className="ws-data-summary-count">
              {matchedRowCount.toLocaleString("en-GB")} of{" "}
              {totalRowCount.toLocaleString("en-GB")}{" "}
              {totalRowCount === 1 ? "row" : "rows"} matched
            </span>
          </div>
          <div className="ws-data-summary-actions">
            <button
              type="button"
              className="ws-button ws-button--primary ws-button--prominent"
              onClick={handleUseAsContext}
              disabled={busy || (result === null && table === null)}
              aria-label="Use query summary as context for AI"
            >
              <Icon name="spark" size={16} />
              <span>Use as context</span>
            </button>
          </div>
        </div>

        {allProblems.length > 0 ? (
          <div
            className="ws-data-problems"
            role="note"
            aria-label="Spreadsheet notices"
          >
            <div className="ws-data-problems-header">
              <Icon name="help" size={16} />
              <strong>Notices about this data</strong>
            </div>
            <ul className="ws-data-problems-list">
              {allProblems.map((prob, idx) => (
                <li key={idx} className="ws-data-problem-item">
                  {prob}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {table !== null && table.columns.length > 0 ? (
          <div
            className="ws-data-columns-bar"
            aria-label="Detected column types"
          >
            <span className="ws-data-columns-heading">Detected columns:</span>
            <div className="ws-data-columns-list" role="list">
              {table.columns.map((col) => (
                <span
                  key={col.index}
                  className="ws-data-column-pill"
                  role="listitem"
                >
                  <span className="ws-data-column-name">{col.name}</span>
                  <span
                    className={`ws-badge ws-badge--type ws-badge--${col.type}`}
                  >
                    {col.type}
                  </span>
                </span>
              ))}
            </div>
          </div>
        ) : null}

        <form
          className="ws-data-controls-form"
          onSubmit={handleApplyQuery}
          aria-label="Filter and calculate spreadsheet"
        >
          <div className="ws-data-filters-section">
            <div className="ws-data-section-header">
              <span className="ws-data-section-title">Filters</span>
              <button
                type="button"
                className="ws-button ws-button--secondary ws-button--small"
                onClick={handleAddFilter}
                disabled={busy || table === null || table.columns.length === 0}
                aria-label="Add filter"
              >
                <Icon name="plus" size={14} />
                <span>Add filter</span>
              </button>
            </div>

            {filters.length === 0 ? (
              <p className="ws-data-empty-filters-text">
                No filters applied. Add a filter to narrow the data.
              </p>
            ) : (
              <div className="ws-data-filters-list">
                {filters.map((f) => {
                  const colType = getColumnType(
                    table?.columns[f.column]?.name ?? "",
                    f.column,
                    table
                  );
                  const operatorOptions = getOperatorsForColumnType(colType);
                  const requiresValue =
                    f.op !== "empty" && f.op !== "not-empty";
                  const isBetween = f.op === "between";

                  return (
                    <div key={f.id} className="ws-data-filter-row">
                      <select
                        className="ws-select"
                        value={f.column}
                        onChange={(e: ChangeEvent<HTMLSelectElement>) =>
                          handleFilterColumnChange(
                            f.id,
                            Number(e.target.value)
                          )
                        }
                        aria-label="Filter column"
                        disabled={busy || table === null}
                      >
                        {table?.columns.map((c) => (
                          <option key={c.index} value={c.index}>
                            {c.name} ({c.type})
                          </option>
                        ))}
                      </select>

                      <select
                        className="ws-select"
                        value={f.op}
                        onChange={(e: ChangeEvent<HTMLSelectElement>) =>
                          handleFilterOpChange(
                            f.id,
                            e.target.value as FilterOp
                          )
                        }
                        aria-label="Filter condition"
                        disabled={busy}
                      >
                        {operatorOptions.map((opt) => (
                          <option key={opt.op} value={opt.op}>
                            {opt.label}
                          </option>
                        ))}
                      </select>

                      {requiresValue ? (
                        isBetween ? (
                          <div className="ws-data-range-inputs">
                            <input
                              type="text"
                              className="ws-input"
                              value={f.value}
                              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                                handleFilterValueChange(f.id, e.target.value)
                              }
                              placeholder="From"
                              aria-label="From value"
                              disabled={busy}
                            />
                            <input
                              type="text"
                              className="ws-input"
                              value={f.value2 ?? ""}
                              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                                handleFilterValue2Change(f.id, e.target.value)
                              }
                              placeholder="To"
                              aria-label="To value"
                              disabled={busy}
                            />
                          </div>
                        ) : (
                          <input
                            type="text"
                            className="ws-input"
                            value={f.value}
                            onChange={(e: ChangeEvent<HTMLInputElement>) =>
                              handleFilterValueChange(f.id, e.target.value)
                            }
                            placeholder="Value to match"
                            aria-label="Filter value"
                            disabled={busy}
                          />
                        )
                      ) : (
                        <span className="ws-data-no-value-needed">
                          (no value required)
                        </span>
                      )}

                      <IconButton
                        icon="close"
                        label="Remove filter"
                        onClick={() => handleRemoveFilter(f.id)}
                        disabled={busy}
                      />
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="ws-data-analytics-bar">
            <div className="ws-data-control-group">
              <label htmlFor="agg-fn-select" className="ws-label">
                Calculation
              </label>
              <select
                id="agg-fn-select"
                className="ws-select"
                value={aggFn ?? ""}
                onChange={(e: ChangeEvent<HTMLSelectElement>) => {
                  const val = e.target.value as AggregateFunction | "";
                  if (val === "") {
                    setAggFn(null);
                    setAggCol(null);
                  } else {
                    setAggFn(val);
                    if (val === "sum" || val === "avg") {
                      if (
                        eligibleNumericColumns.length > 0 &&
                        (aggCol === null ||
                          !eligibleNumericColumns.some(
                            (c) => c.index === aggCol
                          ))
                      ) {
                        setAggCol(eligibleNumericColumns[0]!.index);
                      }
                    } else if (aggCol === null && table !== null && table.columns.length > 0) {
                      setAggCol(table.columns[0]!.index);
                    }
                  }
                }}
                aria-label="Calculation function"
                disabled={busy || table === null}
              >
                <option value="">None</option>
                <option value="sum">Sum (total)</option>
                <option value="avg">Average</option>
                <option value="count">Count</option>
                <option value="min">Minimum</option>
                <option value="max">Maximum</option>
              </select>
            </div>

            {aggFn !== null && aggFn !== "count" ? (
              <div className="ws-data-control-group">
                <label htmlFor="agg-col-select" className="ws-label">
                  Column
                </label>
                <select
                  id="agg-col-select"
                  className="ws-select"
                  value={aggCol ?? ""}
                  onChange={(e: ChangeEvent<HTMLSelectElement>) =>
                    setAggCol(Number(e.target.value))
                  }
                  aria-label="Column for calculation"
                  disabled={busy || table === null}
                >
                  {(aggFn === "sum" || aggFn === "avg"
                    ? eligibleNumericColumns
                    : table?.columns ?? []
                  ).map((col) => (
                    <option key={col.index} value={col.index}>
                      {col.name} ({col.type})
                    </option>
                  ))}
                </select>
              </div>
            ) : null}

            <div className="ws-data-control-group">
              <label htmlFor="group-by-select" className="ws-label">
                Group by
              </label>
              <select
                id="group-by-select"
                className="ws-select"
                value={groupByCol ?? ""}
                onChange={(e: ChangeEvent<HTMLSelectElement>) => {
                  const val = e.target.value;
                  setGroupByCol(val === "" ? null : Number(val));
                }}
                aria-label="Group by column"
                disabled={busy || table === null}
              >
                <option value="">Do not group</option>
                {table?.columns.map((c) => (
                  <option key={c.index} value={c.index}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="ws-data-control-group">
              <label htmlFor="sort-col-select" className="ws-label">
                Sort
              </label>
              <select
                id="sort-col-select"
                className="ws-select"
                value={sortCol ?? ""}
                onChange={(e: ChangeEvent<HTMLSelectElement>) => {
                  const val = e.target.value;
                  setSortCol(val === "" ? null : Number(val));
                }}
                aria-label="Sort column"
                disabled={busy || table === null}
              >
                <option value="">Default order</option>
                {table?.columns.map((c) => (
                  <option key={c.index} value={c.index}>
                    {c.name}
                  </option>
                ))}
              </select>
              {sortCol !== null ? (
                <select
                  className="ws-select"
                  value={sortDir}
                  onChange={(e: ChangeEvent<HTMLSelectElement>) =>
                    setSortDir(e.target.value as "asc" | "desc")
                  }
                  aria-label="Sort direction"
                  disabled={busy}
                >
                  <option value="asc">Ascending</option>
                  <option value="desc">Descending</option>
                </select>
              ) : null}
            </div>
          </div>

          <div className="ws-data-form-actions">
            <button
              type="submit"
              className="ws-button ws-button--primary"
              disabled={busy || table === null}
            >
              <Icon name="search" size={16} />
              <span>Apply query</span>
            </button>
            <button
              type="button"
              className="ws-button ws-button--subtle"
              onClick={handleReset}
              disabled={busy || table === null}
            >
              <Icon name="refresh" size={16} />
              <span>Reset</span>
            </button>
          </div>
        </form>

        {table === null ? (
          <div className="ws-data-empty-state">
            <Icon name="file" size={32} />
            <p>No spreadsheet data is currently available.</p>
          </div>
        ) : (
          <div
            className="ws-table-scroll"
            role="region"
            aria-label="Spreadsheet data table"
            tabIndex={0}
          >
            <table className="ws-table">
              <thead>
                <tr>
                  {columnsToRender.map((colName, colIdx) => {
                    const colType = getColumnType(colName, colIdx, table);
                    const isNumeric = isNumericColumn(colType);
                    const isSorted = sortCol === colIdx;

                    return (
                      <th
                        key={`${colIdx}-${colName}`}
                        scope="col"
                        style={{ textAlign: getColumnAlignment(colType) }}
                        className="ws-table-header"
                        aria-sort={
                          isSorted
                            ? sortDir === "asc"
                              ? "ascending"
                              : "descending"
                            : "none"
                        }
                      >
                        <button
                          type="button"
                          className="ws-table-sort-trigger"
                          onClick={() => handleHeaderClick(colIdx)}
                          aria-label={`Sort by ${colName}, currently ${
                            isSorted ? sortDir : "unsorted"
                          }`}
                          disabled={busy}
                        >
                          <span className="ws-table-col-name">{colName}</span>
                          <span
                            className={`ws-badge ws-badge--type ws-badge--${colType}`}
                          >
                            {colType}
                          </span>
                          {isSorted ? (
                            <span
                              className="ws-table-sort-mark"
                              aria-hidden="true"
                            >
                              {sortDir === "asc" ? " ↑" : " ↓"}
                            </span>
                          ) : null}
                        </button>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {displayedRows.length === 0 ? (
                  <tr>
                    <td
                      colSpan={Math.max(1, columnsToRender.length)}
                      className="ws-table-empty-cell"
                    >
                      No rows match your query.
                    </td>
                  </tr>
                ) : (
                  displayedRows.map((row, rowIdx) => (
                    <tr key={rowIdx} className="ws-table-row">
                      {columnsToRender.map((colName, colIdx) => {
                        let cellValue = "";
                        if (colIdx < row.length) {
                          cellValue = row[colIdx]!;
                        }
                        const colType = getColumnType(colName, colIdx, table);
                        return (
                          <td
                            key={colIdx}
                            style={{ textAlign: getColumnAlignment(colType) }}
                            className="ws-table-cell"
                          >
                            {cellValue}
                          </td>
                        );
                      })}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}

        {activeRows.length > 0 ? (
          <div className="ws-data-footer-note">
            {remainingRowCount > 0 ? (
              <p>
                Showing first {displayedRows.length} of{" "}
                {activeRows.length.toLocaleString("en-GB")} rows ({" "}
                {remainingRowCount.toLocaleString("en-GB")} more not
                displayed).
              </p>
            ) : (
              <p>
                Showing all {activeRows.length.toLocaleString("en-GB")}{" "}
                {activeRows.length === 1 ? "row" : "rows"}.
              </p>
            )}
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
