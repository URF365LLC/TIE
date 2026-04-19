import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Database, Play, Calculator, AlertCircle, CheckCircle2, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

type Tf = "15m" | "1h" | "4h";

interface Estimate {
  instrumentCount: number;
  perInstrument: Array<{
    canonicalSymbol: string;
    assetClass: string;
    perTimeframe: Record<Tf, { windows: number; credits: number }>;
    totalCredits: number;
  }>;
  totalRequests: number;
  totalCredits: number;
  estimatedSeconds: number;
}

interface Job {
  id: string;
  status: "pending" | "running" | "completed" | "error";
  startedAt: number;
  finishedAt: number | null;
  estimate: Estimate;
  progress: {
    completedRequests: number;
    totalRequests: number;
    instrumentsDone: number;
    instrumentsTotal: number;
    currentSymbol: string | null;
    currentTimeframe: Tf | null;
  };
  results: Array<{
    canonicalSymbol: string;
    timeframe: Tf;
    windows: number;
    candlesUpserted: number;
    indicatorsUpserted: number;
    error?: string;
  }>;
  creditsConsumed: number;
  error: string | null;
}

const ALL_TFS: Tf[] = ["15m", "1h", "4h"];

function fmtDuration(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export default function BackfillPage() {
  const { toast } = useToast();
  const [days, setDays] = useState<number>(7);
  const [timeframes, setTimeframes] = useState<Tf[]>(["15m", "1h", "4h"]);
  const [symbolsText, setSymbolsText] = useState<string>("");
  const [adminToken, setAdminToken] = useState<string>(
    typeof window !== "undefined" ? localStorage.getItem("backfillAdminToken") ?? "" : "",
  );
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [jobId, setJobId] = useState<string | null>(() =>
    typeof window !== "undefined" ? localStorage.getItem("backfillActiveJobId") : null,
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (jobId) localStorage.setItem("backfillActiveJobId", jobId);
    else localStorage.removeItem("backfillActiveJobId");
  }, [jobId]);

  useEffect(() => {
    if (typeof window !== "undefined") localStorage.setItem("backfillAdminToken", adminToken);
  }, [adminToken]);

  const buildHeaders = (json: boolean): HeadersInit => {
    const h: Record<string, string> = {};
    if (json) h["Content-Type"] = "application/json";
    if (adminToken.trim()) h["x-admin-token"] = adminToken.trim();
    return h;
  };

  const parsedSymbols = symbolsText
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const buildPayload = (dryRun: boolean) => ({
    days,
    timeframes,
    ...(parsedSymbols.length ? { symbols: parsedSymbols } : {}),
    dryRun,
  });

  const dryRunMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/admin/backfill", {
        method: "POST",
        headers: buildHeaders(true),
        body: JSON.stringify(buildPayload(true)),
        credentials: "include",
      });
      if (!res.ok) throw new Error(`${res.status}: ${(await res.text()) || res.statusText}`);
      return (await res.json()) as { dryRun: boolean; estimate: Estimate };
    },
    onSuccess: (data) => {
      setEstimate(data.estimate);
      toast({ title: "Estimate ready", description: `${data.estimate.totalCredits} credits across ${data.estimate.instrumentCount} instruments.` });
    },
    onError: (err: Error) => {
      toast({ title: "Estimate failed", description: err.message, variant: "destructive" });
    },
  });

  const startMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/admin/backfill", {
        method: "POST",
        headers: buildHeaders(true),
        body: JSON.stringify(buildPayload(false)),
        credentials: "include",
      });
      if (!res.ok) throw new Error(`${res.status}: ${(await res.text()) || res.statusText}`);
      return (await res.json()) as { jobId: string };
    },
    onSuccess: (data) => {
      setJobId(data.jobId);
      toast({ title: "Backfill started", description: `Job ${data.jobId} is running.` });
    },
    onError: (err: Error) => {
      toast({ title: "Could not start backfill", description: err.message, variant: "destructive" });
    },
  });

  const { data: job } = useQuery<Job>({
    queryKey: ["/api/admin/backfill", jobId],
    enabled: !!jobId,
    queryFn: async () => {
      const res = await fetch(`/api/admin/backfill/${jobId}`, {
        headers: buildHeaders(false),
        credentials: "include",
      });
      if (!res.ok) throw new Error(`${res.status}: ${(await res.text()) || res.statusText}`);
      return (await res.json()) as Job;
    },
    refetchInterval: (q) => {
      const data = q.state.data as Job | undefined;
      if (!data) return 2000;
      return data.status === "running" || data.status === "pending" ? 2000 : false;
    },
  });

  const toggleTf = (tf: Tf, on: boolean) => {
    setTimeframes((cur) => {
      if (on) return Array.from(new Set([...cur, tf])).sort((a, b) => ALL_TFS.indexOf(a) - ALL_TFS.indexOf(b));
      return cur.filter((t) => t !== tf);
    });
  };

  const isRunning = job?.status === "running" || job?.status === "pending";
  const pct = job
    ? job.progress.totalRequests
      ? Math.min(100, Math.round((job.progress.completedRequests / job.progress.totalRequests) * 100))
      : 0
    : 0;

  return (
    <div className="flex flex-col gap-6 p-6 max-w-5xl mx-auto">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight" data-testid="text-backfill-title">
          Backfill
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Pull historical candles and indicators into the database. Estimate the cost first, then kick off a job and watch it run.
        </p>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Database className="w-4 h-4 text-muted-foreground" />
            <div>
              <CardTitle className="text-base font-medium">Run Configuration</CardTitle>
              <CardDescription className="text-xs">Choose the depth, timeframes, and symbols to backfill</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label className="text-sm">Days of History</Label>
              <Input
                type="number"
                min={1}
                max={365}
                value={days}
                onChange={(e) => setDays(Math.max(1, Math.min(365, parseInt(e.target.value) || 1)))}
                data-testid="input-backfill-days"
              />
              <p className="text-[11px] text-muted-foreground">Between 1 and 365 days back from now</p>
            </div>
            <div className="space-y-2">
              <Label className="text-sm">Timeframes</Label>
              <div className="flex items-center gap-4 h-10">
                {ALL_TFS.map((tf) => (
                  <label key={tf} className="flex items-center gap-2 text-sm cursor-pointer">
                    <Checkbox
                      checked={timeframes.includes(tf)}
                      onCheckedChange={(v) => toggleTf(tf, v === true)}
                      data-testid={`checkbox-tf-${tf}`}
                    />
                    <span>{tf}</span>
                  </label>
                ))}
              </div>
              <p className="text-[11px] text-muted-foreground">At least one timeframe required</p>
            </div>
          </div>

          <div className="space-y-2">
            <Label className="text-sm">Symbols (optional)</Label>
            <Input
              placeholder="e.g. EURUSD, BTC/USD, AAPL — leave blank for all enabled instruments"
              value={symbolsText}
              onChange={(e) => setSymbolsText(e.target.value)}
              data-testid="input-backfill-symbols"
            />
            <p className="text-[11px] text-muted-foreground">
              Comma or space separated canonical symbols. Empty means every enabled instrument.
            </p>
          </div>

          <Separator />

          <div className="space-y-2">
            <Label className="text-sm">Admin Token (if required)</Label>
            <Input
              type="password"
              placeholder="x-admin-token header value"
              value={adminToken}
              onChange={(e) => setAdminToken(e.target.value)}
              data-testid="input-admin-token"
            />
            <p className="text-[11px] text-muted-foreground">
              Stored in your browser only. Leave blank if ADMIN_TOKEN is not set on the server.
            </p>
          </div>

          <div className="flex flex-wrap gap-2 justify-end">
            <Button
              variant="outline"
              onClick={() => dryRunMutation.mutate()}
              disabled={dryRunMutation.isPending || timeframes.length === 0}
              data-testid="button-estimate-backfill"
            >
              <Calculator className="w-4 h-4 mr-2" />
              {dryRunMutation.isPending ? "Estimating..." : "Estimate Cost"}
            </Button>
            <Button
              onClick={() => startMutation.mutate()}
              disabled={startMutation.isPending || timeframes.length === 0 || isRunning}
              data-testid="button-start-backfill"
            >
              <Play className="w-4 h-4 mr-2" />
              {startMutation.isPending ? "Starting..." : "Start Backfill"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {estimate && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base font-medium">Dry-Run Estimate</CardTitle>
            <CardDescription className="text-xs">Before any data is fetched</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <Stat label="Instruments" value={estimate.instrumentCount} testId="stat-est-instruments" />
              <Stat label="Total Requests" value={estimate.totalRequests} testId="stat-est-requests" />
              <Stat label="Total Credits" value={estimate.totalCredits} testId="stat-est-credits" />
              <Stat label="ETA" value={fmtDuration(estimate.estimatedSeconds)} testId="stat-est-eta" />
            </div>

            {estimate.perInstrument.length > 0 && (
              <div className="rounded-md border overflow-hidden">
                <div className="max-h-72 overflow-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-muted/50 sticky top-0">
                      <tr>
                        <th className="text-left p-2 font-medium">Symbol</th>
                        <th className="text-left p-2 font-medium">Class</th>
                        {ALL_TFS.map((tf) => (
                          <th key={tf} className="text-right p-2 font-medium">
                            {tf} (windows / credits)
                          </th>
                        ))}
                        <th className="text-right p-2 font-medium">Credits</th>
                      </tr>
                    </thead>
                    <tbody>
                      {estimate.perInstrument.map((row) => (
                        <tr
                          key={row.canonicalSymbol}
                          className="border-t"
                          data-testid={`row-est-${row.canonicalSymbol}`}
                        >
                          <td className="p-2 font-medium">{row.canonicalSymbol}</td>
                          <td className="p-2 text-muted-foreground">{row.assetClass}</td>
                          {ALL_TFS.map((tf) => {
                            const cell = row.perTimeframe[tf];
                            return (
                              <td key={tf} className="p-2 text-right">
                                {cell ? `${cell.windows} / ${cell.credits}` : "—"}
                              </td>
                            );
                          })}
                          <td className="p-2 text-right font-semibold">{row.totalCredits}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {jobId && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-base font-medium flex items-center gap-2">
                  Job Progress
                  <JobBadge status={job?.status} />
                </CardTitle>
                <CardDescription className="text-xs font-mono">{jobId}</CardDescription>
              </div>
              {isRunning && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />}
            </div>
          </CardHeader>
          <CardContent className="space-y-5">
            {!job ? (
              <Skeleton className="h-24 w-full" />
            ) : (
              <>
                <div>
                  <div className="flex items-center justify-between text-xs text-muted-foreground mb-1">
                    <span data-testid="text-progress-counts">
                      {job.progress.completedRequests} / {job.progress.totalRequests} requests
                    </span>
                    <span data-testid="text-progress-pct">{pct}%</span>
                  </div>
                  <Progress value={pct} data-testid="progress-backfill" />
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                  <Stat
                    label="Instruments"
                    value={`${job.progress.instrumentsDone} / ${job.progress.instrumentsTotal}`}
                    testId="stat-job-instruments"
                  />
                  <Stat label="Credits Used" value={job.creditsConsumed} testId="stat-job-credits" />
                  <Stat
                    label="Current Symbol"
                    value={job.progress.currentSymbol ?? "—"}
                    testId="stat-job-current-symbol"
                  />
                  <Stat
                    label="Current TF"
                    value={job.progress.currentTimeframe ?? "—"}
                    testId="stat-job-current-tf"
                  />
                </div>

                {job.error && (
                  <div className="flex items-start gap-2 p-3 rounded-md border border-destructive/30 bg-destructive/10">
                    <AlertCircle className="w-4 h-4 text-destructive mt-0.5" />
                    <div className="text-xs text-destructive" data-testid="text-job-error">
                      {job.error}
                    </div>
                  </div>
                )}

                {job.results.length > 0 && (
                  <div className="rounded-md border overflow-hidden">
                    <div className="max-h-72 overflow-auto">
                      <table className="w-full text-xs">
                        <thead className="bg-muted/50 sticky top-0">
                          <tr>
                            <th className="text-left p-2 font-medium">Symbol</th>
                            <th className="text-left p-2 font-medium">TF</th>
                            <th className="text-right p-2 font-medium">Windows</th>
                            <th className="text-right p-2 font-medium">Candles</th>
                            <th className="text-right p-2 font-medium">Indicators</th>
                            <th className="text-left p-2 font-medium">Error</th>
                          </tr>
                        </thead>
                        <tbody>
                          {job.results.map((r, i) => (
                            <tr
                              key={`${r.canonicalSymbol}-${r.timeframe}-${i}`}
                              className="border-t"
                              data-testid={`row-result-${r.canonicalSymbol}-${r.timeframe}`}
                            >
                              <td className="p-2 font-medium">{r.canonicalSymbol}</td>
                              <td className="p-2">{r.timeframe}</td>
                              <td className="p-2 text-right">{r.windows}</td>
                              <td className="p-2 text-right">{r.candlesUpserted}</td>
                              <td className="p-2 text-right">{r.indicatorsUpserted}</td>
                              <td className="p-2 text-destructive truncate max-w-[200px]" title={r.error}>
                                {r.error ?? ""}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {job.status === "completed" && (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <CheckCircle2 className="w-4 h-4 text-status-online" />
                    <span data-testid="text-job-finished">
                      Completed in {fmtDuration(Math.round(((job.finishedAt ?? Date.now()) - job.startedAt) / 1000))}
                    </span>
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Stat({ label, value, testId }: { label: string; value: string | number; testId: string }) {
  return (
    <div className="rounded-md border p-3">
      <div className="text-[11px] text-muted-foreground uppercase tracking-wide">{label}</div>
      <div className="text-lg font-semibold mt-1" data-testid={testId}>
        {value}
      </div>
    </div>
  );
}

function JobBadge({ status }: { status?: Job["status"] }) {
  if (!status) return null;
  const variants: Record<Job["status"], { label: string; className: string }> = {
    pending: { label: "Pending", className: "bg-muted text-muted-foreground" },
    running: { label: "Running", className: "bg-primary/15 text-primary" },
    completed: { label: "Completed", className: "bg-status-online/15 text-status-online" },
    error: { label: "Error", className: "bg-destructive/15 text-destructive" },
  };
  const v = variants[status];
  return (
    <Badge variant="outline" className={v.className} data-testid="badge-job-status">
      {v.label}
    </Badge>
  );
}
