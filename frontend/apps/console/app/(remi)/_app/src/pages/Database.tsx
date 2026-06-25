import { useEffect, useState, useRef } from "react";
import {
  Database as DatabaseIcon, RefreshCw, Play, Lock, LockOpen,
  ChevronLeft, ChevronRight, ArrowUpDown, X, ChevronDown, ChevronUp,
  Table2, Key, Hash, Eye,
} from "lucide-react";
import { Layout } from "../components/Layout";
import { StatCard } from "../components/ArcCard";
import { useDbStore } from "../stores/db";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { ScrollArea } from "../components/ui/scroll-area";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";
import { cn } from "~remiadmin/lib/utils";
import type { DbTableSchema } from "../api/types";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "string" && value.length > 120) return value.slice(0, 120) + "...";
  return String(value);
}

function cellClass(value: unknown): string {
  if (value === null || value === undefined) return "italic text-muted-foreground/60";
  return "";
}

// ─── Overview Tab ───

function OverviewTab() {
  const {
    stats, statsLoading, fetchStats,
    tableData, tableDataLoading, browsingTable, tablePage, tablePageSize,
    fetchTableData, setTableSort, tableOrderBy, tableOrderDir, closeBrowser,
  } = useDbStore();

  return (
    <div className="space-y-3">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm">Tables</CardTitle>
          <Button variant="ghost" size="sm" onClick={fetchStats} disabled={statsLoading}>
            <RefreshCw className={cn("h-3.5 w-3.5", statsLoading && "animate-spin")} />
          </Button>
        </CardHeader>
        <CardContent className="p-0">
          {!stats ? (
            <div className="px-4 py-12 text-center font-mono text-xs text-muted-foreground">LOADING...</div>
          ) : stats.tables.length === 0 ? (
            <div className="px-4 py-12 text-center font-mono text-xs text-muted-foreground">NO TABLES</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="font-mono text-[10px] uppercase tracking-wider">Name</TableHead>
                  <TableHead className="font-mono text-[10px] uppercase tracking-wider">Type</TableHead>
                  <TableHead className="text-right font-mono text-[10px] uppercase tracking-wider">Rows</TableHead>
                  <TableHead className="w-[60px]" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {stats.tables.map((t) => (
                  <TableRow key={t.name} className={cn(browsingTable === t.name && "bg-accent/30")}>
                    <TableCell className="py-1.5 font-mono text-[11px] font-medium">{t.name}</TableCell>
                    <TableCell className="py-1.5">
                      <Badge variant="outline" className="font-mono text-[9px]">
                        {t.type}
                      </Badge>
                    </TableCell>
                    <TableCell className="py-1.5 text-right font-mono text-[11px]">
                      {t.rowCount.toLocaleString()}
                    </TableCell>
                    <TableCell className="py-1.5">
                      {t.type !== "virtual" && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 px-2 text-[10px]"
                          onClick={() => fetchTableData(t.name, 0)}
                        >
                          <Eye className="mr-1 h-3 w-3" />
                          View
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Table Data Browser */}
      {browsingTable && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <div className="flex items-center gap-2">
              <CardTitle className="text-sm font-mono">{browsingTable}</CardTitle>
              {tableData && (
                <Badge variant="secondary" className="font-mono text-[9px]">
                  {tableData.total.toLocaleString()} rows
                </Badge>
              )}
            </div>
            <div className="flex items-center gap-1.5">
              {tableData && tableData.total > tablePageSize && (
                <div className="flex items-center gap-1">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-6 px-2"
                    disabled={tablePage === 0}
                    onClick={() => fetchTableData(browsingTable, tablePage - 1)}
                  >
                    <ChevronLeft className="h-3 w-3" />
                  </Button>
                  <span className="font-mono text-[10px] text-muted-foreground">
                    {tablePage + 1}/{Math.ceil(tableData.total / tablePageSize)}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-6 px-2"
                    disabled={(tablePage + 1) * tablePageSize >= tableData.total}
                    onClick={() => fetchTableData(browsingTable, tablePage + 1)}
                  >
                    <ChevronRight className="h-3 w-3" />
                  </Button>
                </div>
              )}
              <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={closeBrowser}>
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {tableDataLoading ? (
              <div className="px-4 py-12 text-center font-mono text-xs text-muted-foreground">LOADING...</div>
            ) : !tableData || tableData.rows.length === 0 ? (
              <div className="px-4 py-12 text-center font-mono text-xs text-muted-foreground">NO DATA</div>
            ) : (
              <ScrollArea className="max-h-[500px]">
                <div className="min-w-full overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        {tableData.columns.map((col) => (
                          <TableHead
                            key={col}
                            className="cursor-pointer select-none whitespace-nowrap font-mono text-[10px] uppercase tracking-wider hover:text-foreground"
                            onClick={() => setTableSort(col)}
                          >
                            <span className="inline-flex items-center gap-1">
                              {col}
                              {tableOrderBy === col ? (
                                tableOrderDir === "asc" ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />
                              ) : (
                                <ArrowUpDown className="h-3 w-3 opacity-30" />
                              )}
                            </span>
                          </TableHead>
                        ))}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {tableData.rows.map((row, i) => (
                        <TableRow key={i}>
                          {tableData.columns.map((col) => (
                            <TableCell
                              key={col}
                              className={cn("max-w-[300px] truncate py-1.5 font-mono text-[11px]", cellClass((row as any)[col]))}
                              title={String((row as any)[col] ?? "")}
                            >
                              {formatCell((row as any)[col])}
                            </TableCell>
                          ))}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </ScrollArea>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ─── Schema Tab ───

function SchemaTab() {
  const { schema, schemaLoading, fetchSchema, selectedTable, selectSchemaTable } = useDbStore();

  useEffect(() => {
    if (!schema) fetchSchema();
  }, []);

  const selected: DbTableSchema | undefined = schema?.tables.find((t) => t.name === selectedTable);

  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-[260px_1fr]">
      {/* Left: Table list */}
      <Card className="lg:sticky lg:top-0 lg:self-start">
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm">Tables</CardTitle>
          <Button variant="ghost" size="sm" onClick={fetchSchema} disabled={schemaLoading}>
            <RefreshCw className={cn("h-3.5 w-3.5", schemaLoading && "animate-spin")} />
          </Button>
        </CardHeader>
        <CardContent className="p-0">
          {schemaLoading ? (
            <div className="px-4 py-8 text-center font-mono text-xs text-muted-foreground">LOADING...</div>
          ) : !schema || schema.tables.length === 0 ? (
            <div className="px-4 py-8 text-center font-mono text-xs text-muted-foreground">NO TABLES</div>
          ) : (
            <ScrollArea className="max-h-[500px]">
              {schema.tables.map((t) => (
                <div
                  key={t.name}
                  onClick={() => selectSchemaTable(t.name)}
                  className={cn(
                    "flex cursor-pointer items-center gap-2.5 border-b border-border/50 px-4 py-2.5 transition-colors hover:bg-accent/30",
                    selectedTable === t.name && "bg-primary/5 border-l-2 border-l-primary"
                  )}
                >
                  {t.type === "virtual" ? (
                    <Hash className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  ) : (
                    <Table2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  )}
                  <span className="truncate font-mono text-xs">{t.name}</span>
                  <Badge variant="outline" className="ml-auto shrink-0 font-mono text-[8px]">
                    {t.columns.length}c
                  </Badge>
                </div>
              ))}
            </ScrollArea>
          )}
        </CardContent>
      </Card>

      {/* Right: Schema detail */}
      <Card>
        {!selected ? (
          <CardContent className="flex h-[300px] items-center justify-center">
            <div className="text-center text-muted-foreground">
              <DatabaseIcon className="mx-auto mb-2 h-8 w-8 opacity-20" />
              <div className="font-mono text-xs">SELECT A TABLE</div>
            </div>
          </CardContent>
        ) : (
          <>
            <CardHeader className="pb-3">
              <div className="flex items-center gap-2">
                <CardTitle className="font-mono text-sm">{selected.name}</CardTitle>
                <Badge variant={selected.type === "virtual" ? "secondary" : "outline"} className="text-[9px]">
                  {selected.type}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-5">
              {/* Columns */}
              {selected.columns.length > 0 && (
                <div>
                  <div className="mb-2 font-mono text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                    Columns ({selected.columns.length})
                  </div>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-[40px] font-mono text-[10px] uppercase tracking-wider">#</TableHead>
                        <TableHead className="font-mono text-[10px] uppercase tracking-wider">Name</TableHead>
                        <TableHead className="font-mono text-[10px] uppercase tracking-wider">Type</TableHead>
                        <TableHead className="font-mono text-[10px] uppercase tracking-wider">Nullable</TableHead>
                        <TableHead className="font-mono text-[10px] uppercase tracking-wider">Default</TableHead>
                        <TableHead className="w-[40px] font-mono text-[10px] uppercase tracking-wider">PK</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {selected.columns.map((col) => (
                        <TableRow key={col.cid}>
                          <TableCell className="py-1.5 font-mono text-[11px] text-muted-foreground">{col.cid}</TableCell>
                          <TableCell className="py-1.5 font-mono text-[11px] font-medium">
                            <span className="inline-flex items-center gap-1.5">
                              {col.pk && <Key className="h-3 w-3 text-warning" />}
                              {col.name}
                            </span>
                          </TableCell>
                          <TableCell className="py-1.5">
                            <Badge variant="secondary" className="font-mono text-[9px]">{col.type || "ANY"}</Badge>
                          </TableCell>
                          <TableCell className="py-1.5 font-mono text-[11px]">
                            {col.notnull ? (
                              <span className="text-destructive">NOT NULL</span>
                            ) : (
                              <span className="text-muted-foreground">yes</span>
                            )}
                          </TableCell>
                          <TableCell className="py-1.5 font-mono text-[10px] text-muted-foreground">
                            {col.dflt_value ?? "—"}
                          </TableCell>
                          <TableCell className="py-1.5 text-center font-mono text-[11px]">
                            {col.pk && <span className="text-warning">PK</span>}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}

              {/* Indexes */}
              {selected.indexes.length > 0 && (
                <div>
                  <div className="mb-2 font-mono text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                    Indexes ({selected.indexes.length})
                  </div>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="font-mono text-[10px] uppercase tracking-wider">Name</TableHead>
                        <TableHead className="font-mono text-[10px] uppercase tracking-wider">Columns</TableHead>
                        <TableHead className="font-mono text-[10px] uppercase tracking-wider">Unique</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {selected.indexes.map((idx) => (
                        <TableRow key={idx.name}>
                          <TableCell className="py-1.5 font-mono text-[11px]">{idx.name}</TableCell>
                          <TableCell className="py-1.5">
                            <div className="flex flex-wrap gap-1">
                              {idx.columns.map((col) => (
                                <Badge key={col} variant="outline" className="font-mono text-[9px]">{col}</Badge>
                              ))}
                            </div>
                          </TableCell>
                          <TableCell className="py-1.5 font-mono text-[11px]">
                            {idx.unique ? <span className="text-warning">UNIQUE</span> : "no"}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}

              {/* DDL */}
              {selected.sql && (
                <div>
                  <div className="mb-2 font-mono text-[10px] font-medium uppercase tracking-wider text-muted-foreground">DDL</div>
                  <pre className="overflow-x-auto rounded-md border border-border bg-muted/30 p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
                    {selected.sql}
                  </pre>
                </div>
              )}
            </CardContent>
          </>
        )}
      </Card>
    </div>
  );
}

// ─── SQL Console Tab ───

function SqlConsoleTab() {
  const {
    sqlQuery, setSqlQuery, executeQuery, queryLoading, queryResult,
    readOnlyMode, toggleReadOnly, clearQueryResult, sqlHistory,
  } = useDbStore();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [historyOpen, setHistoryOpen] = useState(false);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      executeQuery();
    }
  };

  return (
    <div className="space-y-3">
      {/* Editor */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm">SQL Console</CardTitle>
          <Button
            variant={readOnlyMode ? "outline" : "destructive"}
            size="sm"
            className="h-7 gap-1.5 text-[10px]"
            onClick={toggleReadOnly}
          >
            {readOnlyMode ? <Lock className="h-3 w-3" /> : <LockOpen className="h-3 w-3" />}
            {readOnlyMode ? "READ ONLY" : "READ / WRITE"}
          </Button>
        </CardHeader>
        <CardContent>
          <textarea
            ref={textareaRef}
            className="min-h-[120px] w-full resize-y rounded-md border border-input bg-muted/30 p-3 font-mono text-[12px] leading-relaxed placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-ring"
            placeholder="SELECT * FROM conversations ORDER BY created_at DESC LIMIT 10;"
            value={sqlQuery}
            onChange={(e) => setSqlQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            spellCheck={false}
          />
          <div className="mt-2 flex items-center justify-between">
            <span className="font-mono text-[10px] text-muted-foreground">
              {readOnlyMode ? "Read-only mode" : "⚠ Write mode enabled"} · Ctrl+Enter to execute
            </span>
            <div className="flex gap-1.5">
              {queryResult && (
                <Button variant="ghost" size="sm" className="h-7 text-[10px]" onClick={clearQueryResult}>
                  Clear
                </Button>
              )}
              <Button
                size="sm"
                className="h-7 gap-1 text-[10px]"
                onClick={executeQuery}
                disabled={queryLoading || !sqlQuery.trim()}
              >
                <Play className="h-3 w-3" />
                Execute
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Results */}
      {queryResult && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <div className="flex items-center gap-2">
              <CardTitle className="text-sm">Results</CardTitle>
              {!queryResult.error && (
                <>
                  <Badge variant="secondary" className="font-mono text-[9px]">
                    {queryResult.type === "execute"
                      ? `${queryResult.changes} affected`
                      : `${queryResult.rowCount} rows`}
                  </Badge>
                  {queryResult.truncated && (
                    <Badge variant="outline" className="border-warning/30 font-mono text-[9px] text-warning">
                      TRUNCATED
                    </Badge>
                  )}
                </>
              )}
            </div>
            <span className="font-mono text-[10px] text-muted-foreground">
              {queryResult.executionMs.toFixed(1)}ms
            </span>
          </CardHeader>
          <CardContent className="p-0">
            {queryResult.error ? (
              <div className="border-t border-border px-4 py-4 font-mono text-xs text-destructive">
                {queryResult.error}
              </div>
            ) : queryResult.type === "execute" ? (
              <div className="border-t border-border px-4 py-4 font-mono text-xs text-success">
                Query executed successfully. {queryResult.changes} row(s) affected.
              </div>
            ) : queryResult.rowCount === 0 ? (
              <div className="border-t border-border px-4 py-8 text-center font-mono text-xs text-muted-foreground">
                NO RESULTS
              </div>
            ) : (
              <ScrollArea className="max-h-[400px]">
                <div className="min-w-full overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        {queryResult.columns.map((col) => (
                          <TableHead key={col} className="whitespace-nowrap font-mono text-[10px] uppercase tracking-wider">
                            {col}
                          </TableHead>
                        ))}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {queryResult.rows.map((row, i) => (
                        <TableRow key={i}>
                          {row.map((cell, j) => (
                            <TableCell
                              key={j}
                              className={cn("max-w-[300px] truncate py-1.5 font-mono text-[11px]", cellClass(cell))}
                              title={String(cell ?? "")}
                            >
                              {formatCell(cell)}
                            </TableCell>
                          ))}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </ScrollArea>
            )}
          </CardContent>
        </Card>
      )}

      {/* History */}
      {sqlHistory.length > 0 && (
        <Card>
          <CardHeader
            className="flex cursor-pointer flex-row items-center justify-between space-y-0 pb-2"
            onClick={() => setHistoryOpen(!historyOpen)}
          >
            <CardTitle className="text-sm">
              Query History
              <Badge variant="outline" className="ml-2 font-mono text-[9px]">{sqlHistory.length}</Badge>
            </CardTitle>
            {historyOpen ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
          </CardHeader>
          {historyOpen && (
            <CardContent className="p-0">
              <ScrollArea className="max-h-[250px]">
                {sqlHistory.map((entry, i) => (
                  <div
                    key={i}
                    className="cursor-pointer border-b border-border/50 px-4 py-2 transition-colors hover:bg-accent/30"
                    onClick={() => setSqlQuery(entry.sql)}
                  >
                    <div className="truncate font-mono text-[11px]">{entry.sql}</div>
                    <div className="mt-0.5 font-mono text-[9px] text-muted-foreground">
                      {new Date(entry.ts).toLocaleString()}
                    </div>
                  </div>
                ))}
              </ScrollArea>
            </CardContent>
          )}
        </Card>
      )}
    </div>
  );
}

// ─── Main Page ───

export function Database() {
  const { stats, fetchStats } = useDbStore();
  const [tab, setTab] = useState("overview");

  useEffect(() => {
    fetchStats();
  }, []);

  return (
    <Layout title="Database" subtitle="SQLITE + SQLITE-VEC">
      {/* Stat Cards */}
      <div className="mb-3 grid grid-cols-2 gap-2 sm:mb-4 sm:grid-cols-4 sm:gap-3">
        <StatCard
          label="DB Size"
          value={stats ? formatBytes(stats.dbSizeBytes) : "—"}
          sub={stats ? `${stats.journalMode.toUpperCase()} mode` : "—"}
        />
        <StatCard
          label="Tables"
          value={String(stats?.totalTables ?? "—")}
          sub={stats?.vecEnabled ? "sqlite-vec enabled" : "sqlite-vec disabled"}
          color={stats?.vecEnabled ? "success" : "default"}
        />
        <StatCard
          label="Total Rows"
          value={stats ? stats.totalRows.toLocaleString() : "—"}
          sub={`across ${stats?.totalTables ?? 0} tables`}
        />
        <StatCard
          label="SQLite"
          value={stats?.sqliteVersion ?? "—"}
          sub={stats?.dbPath ?? "~/.remi/remi.db"}
        />
      </div>

      {/* Tabs */}
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="mb-3">
          <TabsTrigger value="overview" className="gap-1.5 text-xs">
            <Table2 className="h-3.5 w-3.5" />
            Overview
          </TabsTrigger>
          <TabsTrigger value="schema" className="gap-1.5 text-xs">
            <DatabaseIcon className="h-3.5 w-3.5" />
            Schema
          </TabsTrigger>
          <TabsTrigger value="sql" className="gap-1.5 text-xs">
            <Play className="h-3.5 w-3.5" />
            SQL Console
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview">
          <OverviewTab />
        </TabsContent>
        <TabsContent value="schema">
          <SchemaTab />
        </TabsContent>
        <TabsContent value="sql">
          <SqlConsoleTab />
        </TabsContent>
      </Tabs>
    </Layout>
  );
}
