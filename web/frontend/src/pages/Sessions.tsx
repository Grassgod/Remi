import { useEffect, useState } from "react";
import { Layout } from "../components/Layout";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "../components/ui/dialog";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "../components/ui/table";
import { Monitor, Trash2, AlertTriangle } from "lucide-react";
import { useAppStore } from "../stores/app";

export function Sessions() {
  const { sessions, fetchSessions, clearSession, clearAllSessions } = useAppStore();
  const [confirmKey, setConfirmKey] = useState<string | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);

  useEffect(() => { fetchSessions(); }, []);

  const handleClear = async (key: string) => {
    await clearSession(key);
    setConfirmKey(null);
  };

  const handleClearAll = async () => {
    await clearAllSessions();
    setConfirmAll(false);
  };

  return (
    <Layout title="Sessions" subtitle="Conversation Management">
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Monitor className="h-4 w-4 text-muted-foreground" />
            Active Sessions
            <Badge variant="secondary" className="text-[10px]">{sessions.length}</Badge>
          </CardTitle>
          {sessions.length > 0 && (
            <Button
              variant="destructive"
              size="sm"
              className="h-7 text-xs"
              onClick={() => setConfirmAll(true)}
            >
              <Trash2 className="mr-1 h-3 w-3" /> Clear All
            </Button>
          )}
        </CardHeader>
        <CardContent className="p-0">
          {sessions.length === 0 ? (
            <div className="p-10 text-center text-xs text-muted-foreground">No active sessions</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Key</TableHead>
                  <TableHead>Session ID</TableHead>
                  <TableHead className="w-[50px]">Type</TableHead>
                  <TableHead className="w-[40px]" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {sessions.map((s, i) => (
                  <TableRow key={i}>
                    <TableCell className="break-all font-mono text-xs">{s.key}</TableCell>
                    <TableCell className="break-all font-mono text-[10px] text-muted-foreground">{s.sessionId}</TableCell>
                    <TableCell>
                      <Badge variant={s.isThread ? "outline" : "secondary"} className="text-[9px]">
                        {s.isThread ? "Thread" : "Main"}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-muted-foreground hover:text-destructive"
                        onClick={() => setConfirmKey(s.key)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Single session delete dialog */}
      <Dialog open={confirmKey !== null} onOpenChange={(open) => { if (!open) setConfirmKey(null); }}>
        <DialogContent onClose={() => setConfirmKey(null)}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-warning" /> Confirm Delete
            </DialogTitle>
            <DialogDescription>
              Clear session "{confirmKey}"? This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmKey(null)}>Cancel</Button>
            <Button variant="destructive" onClick={() => confirmKey && handleClear(confirmKey)}>Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Clear all dialog */}
      <Dialog open={confirmAll} onOpenChange={setConfirmAll}>
        <DialogContent onClose={() => setConfirmAll(false)}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" /> Clear All Sessions
            </DialogTitle>
            <DialogDescription>
              This will clear all {sessions.length} sessions. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmAll(false)}>Cancel</Button>
            <Button variant="destructive" onClick={handleClearAll}>Clear All</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Layout>
  );
}
