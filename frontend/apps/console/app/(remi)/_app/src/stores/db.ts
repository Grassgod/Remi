import { create } from "zustand";
import { getDbStats, getDbSchema, getDbTableData, executeDbQuery } from "../api/client";
import type { DbStats, DbSchemaResponse, DbTableDataResponse, DbQueryResult } from "../api/types";

const HISTORY_KEY = "remi-sql-history";
const MAX_HISTORY = 20;

function loadHistory(): Array<{ sql: string; ts: string }> {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
  } catch { return []; }
}

function saveHistory(h: Array<{ sql: string; ts: string }>) {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(h.slice(0, MAX_HISTORY)));
}

interface DbStore {
  // Overview
  stats: DbStats | null;
  statsLoading: boolean;

  // Schema
  schema: DbSchemaResponse | null;
  schemaLoading: boolean;
  selectedTable: string | null;

  // Table browser
  tableData: DbTableDataResponse | null;
  tableDataLoading: boolean;
  tablePage: number;
  tablePageSize: number;
  tableOrderBy: string | null;
  tableOrderDir: "asc" | "desc";
  browsingTable: string | null;

  // SQL Console
  sqlQuery: string;
  sqlHistory: Array<{ sql: string; ts: string }>;
  queryResult: DbQueryResult | null;
  queryLoading: boolean;
  readOnlyMode: boolean;

  // Actions
  fetchStats: () => Promise<void>;
  fetchSchema: () => Promise<void>;
  fetchTableData: (tableName: string, page?: number) => Promise<void>;
  setTableSort: (column: string) => void;
  selectSchemaTable: (name: string | null) => void;
  setSqlQuery: (sql: string) => void;
  executeQuery: () => Promise<void>;
  toggleReadOnly: () => void;
  clearQueryResult: () => void;
  closeBrowser: () => void;
}

export const useDbStore = create<DbStore>((set, get) => ({
  stats: null,
  statsLoading: false,
  schema: null,
  schemaLoading: false,
  selectedTable: null,
  tableData: null,
  tableDataLoading: false,
  tablePage: 0,
  tablePageSize: 50,
  tableOrderBy: null,
  tableOrderDir: "desc",
  browsingTable: null,
  sqlQuery: "",
  sqlHistory: loadHistory(),
  queryResult: null,
  queryLoading: false,
  readOnlyMode: true,

  fetchStats: async () => {
    set({ statsLoading: true });
    try {
      const stats = await getDbStats();
      set({ stats });
    } catch { /* ignore */ }
    set({ statsLoading: false });
  },

  fetchSchema: async () => {
    set({ schemaLoading: true });
    try {
      const schema = await getDbSchema();
      set({ schema });
    } catch { /* ignore */ }
    set({ schemaLoading: false });
  },

  fetchTableData: async (tableName: string, page?: number) => {
    const s = get();
    const p = page ?? s.tablePage;
    set({ tableDataLoading: true, browsingTable: tableName, tablePage: p });
    try {
      const data = await getDbTableData(tableName, {
        limit: s.tablePageSize,
        offset: p * s.tablePageSize,
        orderBy: s.tableOrderBy ?? undefined,
        orderDir: s.tableOrderDir,
      });
      set({ tableData: data });
    } catch { /* ignore */ }
    set({ tableDataLoading: false });
  },

  setTableSort: (column: string) => {
    const s = get();
    if (s.tableOrderBy === column) {
      set({ tableOrderDir: s.tableOrderDir === "asc" ? "desc" : "asc" });
    } else {
      set({ tableOrderBy: column, tableOrderDir: "desc" });
    }
    if (s.browsingTable) get().fetchTableData(s.browsingTable, 0);
  },

  selectSchemaTable: (name) => set({ selectedTable: name }),

  setSqlQuery: (sql) => set({ sqlQuery: sql }),

  executeQuery: async () => {
    const { sqlQuery, readOnlyMode, sqlHistory } = get();
    if (!sqlQuery.trim()) return;
    set({ queryLoading: true, queryResult: null });
    try {
      const result = await executeDbQuery(sqlQuery, readOnlyMode);
      const newHist = [{ sql: sqlQuery, ts: new Date().toISOString() }, ...sqlHistory].slice(0, MAX_HISTORY);
      saveHistory(newHist);
      set({ queryResult: result, sqlHistory: newHist });
    } catch (err) {
      set({ queryResult: { columns: [], rows: [], rowCount: 0, executionMs: 0, type: "query", error: (err as Error).message } });
    }
    set({ queryLoading: false });
  },

  toggleReadOnly: () => set((s) => ({ readOnlyMode: !s.readOnlyMode })),
  clearQueryResult: () => set({ queryResult: null }),
  closeBrowser: () => set({ tableData: null, browsingTable: null, tablePage: 0, tableOrderBy: null, tableOrderDir: "desc" }),
}));
