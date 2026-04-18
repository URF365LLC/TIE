import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Loader2, History, Sparkles, Archive, EyeOff, CheckCircle2 } from "lucide-react";
import type { StrategyParameters, StrategyParamsConfig } from "@shared/schema";

interface HistoryRow extends StrategyParameters {
  lifetimeStats: { total: number; wins: number; losses: number; missed: number; winRate: number | null };
}
interface RollingRow {
  paramSetId: number;
  version: number;
  name: string;
  status: string;
  total: number;
  wins: number;
  losses: number;
  winRate: number | null;
}

export default function ParameterHistoryPage() {
  const { toast } = useToast();
  const [windowDays, setWindowDays] = useState(30);

  const { data: history, isLoading } = useQuery<HistoryRow[]>({
    queryKey: ["/api/strategy-parameters/history"],
  });
  const { data: rolling } = useQuery<{ windowDays: number; rows: RollingRow[] }>({
    queryKey: ["/api/strategy-parameters/rolling-winrate", windowDays],
    queryFn: async () => {
      const res = await fetch(`/api/strategy-parameters/rolling-winrate?days=${windowDays}`);
      return res.json();
    },
  });

  const candidateMutation = useMutation({
    mutationFn: async (saveAsDraft: boolean) => {
      const res = await apiRequest("POST", "/api/advisor/optimizer-candidate", { saveAsDraft });
      return await res.json();
    },
    onSuccess: (data: any) => {
      if (!data.candidate) {
        toast({ title: "No candidate", description: data.message ?? "Not enough data" });
        return;
      }
      const changeCount = data.candidate.rationale.changes.length;
      toast({
        title: data.saved ? "Candidate saved as draft" : "Candidate generated",
        description: `${changeCount} parameter change(s) suggested. ${data.saved ? "Visible below as draft." : "Save to keep it."}`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/strategy-parameters/history"] });
      queryClient.invalidateQueries({ queryKey: ["/api/strategy-parameters"] });
    },
    onError: (err: any) => toast({ title: "Generation failed", description: err.message, variant: "destructive" }),
  });

  const statusMutation = useMutation({
    mutationFn: async ({ id, status }: { id: number; status: "shadow" | "archived" | "draft" }) => {
      const res = await apiRequest("POST", `/api/strategy-parameters/${id}/status`, { status });
      return await res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/strategy-parameters/history"] });
      queryClient.invalidateQueries({ queryKey: ["/api/strategy-parameters"] });
    },
    onError: (err: any) => toast({ title: "Update failed", description: err.message, variant: "destructive" }),
  });

  const activateMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("POST", `/api/strategy-parameters/${id}/activate`);
      return await res.json();
    },
    onSuccess: (row: any) => {
      toast({ title: "Promoted to active", description: `v${row.version} ${row.name}` });
      queryClient.invalidateQueries({ queryKey: ["/api/strategy-parameters/history"] });
      queryClient.invalidateQueries({ queryKey: ["/api/strategy-parameters"] });
      queryClient.invalidateQueries({ queryKey: ["/api/strategy-parameters/rolling-winrate", windowDays] });
    },
  });

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <History className="w-5 h-5" />
          <h1 className="text-2xl font-semibold">Parameter History & Self-Improvement</h1>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => candidateMutation.mutate(false)} disabled={candidateMutation.isPending} data-testid="button-preview-candidate">
            <Sparkles className="w-4 h-4 mr-2" /> Preview optimizer candidate
          </Button>
          <Button onClick={() => candidateMutation.mutate(true)} disabled={candidateMutation.isPending} data-testid="button-save-candidate">
            {candidateMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Sparkles className="w-4 h-4 mr-2" />}
            Save candidate as draft
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Self-improvement dashboard — rolling {windowDays}d win rate by version</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-2 mb-3 text-sm">
            <span>Window:</span>
            {[7, 14, 30, 60, 90].map((d) => (
              <Button key={d} variant={d === windowDays ? "default" : "outline"} size="sm" onClick={() => setWindowDays(d)} data-testid={`button-window-${d}`}>
                {d}d
              </Button>
            ))}
          </div>
          <Table>
            <TableHeader>
              <TableRow><TableHead>Version</TableHead><TableHead>Name</TableHead><TableHead>Status</TableHead><TableHead>Resolved</TableHead><TableHead>Wins</TableHead><TableHead>Losses</TableHead><TableHead>Win rate</TableHead><TableHead>Bar</TableHead></TableRow>
            </TableHeader>
            <TableBody>
              {rolling?.rows.map((r) => (
                <TableRow key={r.paramSetId} data-testid={`row-rolling-${r.paramSetId}`}>
                  <TableCell>v{r.version}</TableCell>
                  <TableCell>{r.name}</TableCell>
                  <TableCell><StatusBadge status={r.status} /></TableCell>
                  <TableCell>{r.total}</TableCell>
                  <TableCell>{r.wins}</TableCell>
                  <TableCell>{r.losses}</TableCell>
                  <TableCell data-testid={`text-winrate-${r.paramSetId}`}>{r.winRate != null ? `${r.winRate.toFixed(1)}%` : "—"}</TableCell>
                  <TableCell className="w-32">
                    {r.winRate != null ? (
                      <div className="h-2 w-full rounded bg-muted overflow-hidden">
                        <div className="h-full bg-primary" style={{ width: `${Math.min(100, Math.max(0, r.winRate))}%` }} />
                      </div>
                    ) : <span className="text-xs text-muted-foreground">no data</span>}
                  </TableCell>
                </TableRow>
              ))}
              {!rolling?.rows.length && (
                <TableRow><TableCell colSpan={8} className="text-center text-muted-foreground">No data</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">All parameter set versions</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow><TableHead>Version</TableHead><TableHead>Name</TableHead><TableHead>Status</TableHead><TableHead>Lifetime</TableHead><TableHead>4h gate</TableHead><TableHead>Created</TableHead><TableHead className="text-right">Actions</TableHead></TableRow>
              </TableHeader>
              <TableBody>
                {history?.map((p) => {
                  const params = p.params as StrategyParamsConfig;
                  return (
                    <TableRow key={p.id} data-testid={`row-history-${p.id}`}>
                      <TableCell>v{p.version}</TableCell>
                      <TableCell>
                        <div className="flex flex-col">
                          <span>{p.name}</span>
                          {p.description && <span className="text-xs text-muted-foreground">{p.description}</span>}
                        </div>
                      </TableCell>
                      <TableCell><StatusBadge status={p.status} isActive={p.isActive} /></TableCell>
                      <TableCell>
                        {p.lifetimeStats.winRate != null ? (
                          <div className="text-sm">
                            <span className="font-medium" data-testid={`text-lifetime-${p.id}`}>{p.lifetimeStats.winRate.toFixed(1)}%</span>
                            <span className="text-xs text-muted-foreground ml-1">({p.lifetimeStats.wins}W / {p.lifetimeStats.losses}L)</span>
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">no signals</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {params.confluence?.requireHtfAlignment ? <Badge variant="default">on</Badge> : <Badge variant="outline">off</Badge>}
                      </TableCell>
                      <TableCell className="text-xs">{new Date(p.createdAt).toISOString().slice(0, 10)}</TableCell>
                      <TableCell className="text-right space-x-1">
                        {!p.isActive && p.status !== "archived" && (
                          <Button size="sm" variant="outline" onClick={() => statusMutation.mutate({ id: p.id, status: "shadow" })} data-testid={`button-shadow-${p.id}`}>
                            <EyeOff className="w-3 h-3 mr-1" /> Shadow
                          </Button>
                        )}
                        {!p.isActive && (
                          <ConfirmActivate onConfirm={() => activateMutation.mutate(p.id)} version={p.version} />
                        )}
                        {!p.isActive && p.status !== "archived" && (
                          <Button size="sm" variant="ghost" onClick={() => statusMutation.mutate({ id: p.id, status: "archived" })} data-testid={`button-archive-${p.id}`}>
                            <Archive className="w-3 h-3" />
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function StatusBadge({ status, isActive }: { status: string; isActive?: boolean }) {
  if (isActive) return <Badge className="bg-status-online">active</Badge>;
  const variant: "default" | "secondary" | "outline" | "destructive" =
    status === "draft" ? "outline" : status === "active" ? "default" : "secondary";
  return <Badge variant={variant}>{status}</Badge>;
}

function ConfirmActivate({ onConfirm, version }: { onConfirm: () => void; version: number }) {
  const [open, setOpen] = useState(false);
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button size="sm" data-testid={`button-promote-${version}`}><CheckCircle2 className="w-3 h-3 mr-1" />Promote</Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Promote v{version} to active?</AlertDialogTitle>
          <AlertDialogDescription>
            This becomes the live parameter set for the scanner. The currently-active set will be archived. Promotion takes effect on the next scan tick.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={() => { onConfirm(); setOpen(false); }} data-testid="button-confirm-promote">Promote</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
