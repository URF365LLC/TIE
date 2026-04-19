import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogTrigger } from "@/components/ui/dialog";
import { TrendingUp, TrendingDown, Trophy, XCircle, HelpCircle, Filter, X, BarChart3, Target, Percent, Scale, ChevronDown, ChevronUp, RefreshCcw } from "lucide-react";
import { Link } from "wouter";
import type { SignalWithInstrument, Settings } from "@shared/schema";
import { SignalJournal, SummaryLine, DeepDiveButton } from "@/components/signal-journal";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface ReclassifyReport {
  scanned: number;
  flippedToWin: number;
  flippedToLoss: number;
  stillMissed: number;
  skippedNoLevels: number;
  skippedNoCandles: number;
  windowHours: number;
  byStrategy: Record<string, { scanned: number; flippedToWin: number; flippedToLoss: number; stillMissed: number }>;
}

interface BacktestStats {
  total: number;
  resolvedTotal: number;
  wins: number;
  losses: number;
  missed: number;
  unresolved: number;
  byStrategy: Record<string, { total: number; wins: number; losses: number }>;
  byDirection: Record<string, { total: number; wins: number; losses: number }>;
  takenWins: number;
  takenTotal: number;
  takenResolved: number;
}

export default function BacktestPage() {
  const [strategyFilter, setStrategyFilter] = useState<string>("all");
  const [directionFilter, setDirectionFilter] = useState<string>("all");
  const [outcomeFilter, setOutcomeFilter] = useState<string>("all");
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const queryParams = new URLSearchParams();
  if (strategyFilter !== "all") queryParams.set("strategy", strategyFilter);
  if (directionFilter !== "all") queryParams.set("direction", directionFilter);
  if (outcomeFilter !== "all") queryParams.set("outcome", outcomeFilter);
  const qs = queryParams.toString();

  const { data: stats, isLoading: statsLoading } = useQuery<BacktestStats>({
    queryKey: ["/api/backtest/stats"],
    refetchInterval: 30000,
  });

  const { data: signals, isLoading: signalsLoading } = useQuery<SignalWithInstrument[]>({
    queryKey: ["/api/backtest/signals", qs ? `?${qs}` : ""],
    refetchInterval: 30000,
  });

  const { data: settings } = useQuery<Settings>({ queryKey: ["/api/settings"] });

  const hasFilters = strategyFilter !== "all" || directionFilter !== "all" || outcomeFilter !== "all";
  // Win rate is wins / (wins + losses): MISSED signals didn't reach a verdict so they
  // tell us nothing about strategy edge and should not dilute the percentage.
  const winRate = stats && stats.resolvedTotal > 0 ? ((stats.wins / stats.resolvedTotal) * 100).toFixed(1) : "—";
  const takenWinRate = stats && stats.takenResolved > 0 ? ((stats.takenWins / stats.takenResolved) * 100).toFixed(1) : "—";

  return (
    <div className="flex flex-col gap-6 p-6 max-w-7xl mx-auto">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight" data-testid="text-backtest-title">Backtest</h1>
          <p className="text-sm text-muted-foreground mt-1">Strategy performance analysis on archived signals</p>
        </div>
        <ReclassifyMissedDialog missedCount={stats?.missed ?? 0} />
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <StatCard
          title="Win Rate"
          value={statsLoading ? undefined : `${winRate}%`}
          subtitle={stats ? `${stats.wins}W / ${stats.losses}L / ${stats.missed}M${stats.unresolved > 0 ? ` · ${stats.unresolved} pending` : ""}` : ""}
          icon={<Percent className="w-4 h-4" />}
          loading={statsLoading}
          highlight={stats ? stats.wins > stats.losses : false}
        />
        <StatCard
          title="Total Signals"
          value={statsLoading ? undefined : String(stats?.total ?? 0)}
          subtitle="archived"
          icon={<BarChart3 className="w-4 h-4" />}
          loading={statsLoading}
        />
        <StatCard
          title="Your Win Rate"
          value={statsLoading ? undefined : `${takenWinRate}%`}
          subtitle={stats ? `${stats.takenWins}W / ${stats.takenResolved} resolved · ${stats.takenTotal} taken` : ""}
          icon={<Target className="w-4 h-4" />}
          loading={statsLoading}
          highlight={stats ? stats.takenWins > 0 : false}
        />
        <StatCard
          title="Strategies"
          value={statsLoading ? undefined : String(Object.keys(stats?.byStrategy ?? {}).length)}
          subtitle="tracked"
          icon={<Trophy className="w-4 h-4" />}
          loading={statsLoading}
        />
      </div>

      {stats && Object.keys(stats.byStrategy).length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {Object.entries(stats.byStrategy).map(([strat, data]) => {
            const resolved = data.wins + data.losses;
            const wr = resolved > 0 ? ((data.wins / resolved) * 100).toFixed(1) : "0";
            return (
              <Card key={strat} data-testid={`strategy-card-${strat.toLowerCase()}`}>
                <CardContent className="p-4">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs text-muted-foreground font-medium uppercase tracking-wider">
                      {strat.replace(/_/g, " ")}
                    </span>
                  </div>
                  <div className="flex items-baseline gap-2">
                    <span className="text-2xl font-bold">{wr}%</span>
                    <span className="text-xs text-muted-foreground">win rate</span>
                  </div>
                  <div className="flex items-center gap-2 mt-2">
                    <ProgressBar value={parseFloat(wr)} />
                    <span className="text-xs text-muted-foreground whitespace-nowrap">{data.wins}/{resolved} · {data.total} total</span>
                  </div>
                </CardContent>
              </Card>
            );
          })}
          {Object.entries(stats.byDirection).map(([dir, data]) => {
            const resolved = data.wins + data.losses;
            const wr = resolved > 0 ? ((data.wins / resolved) * 100).toFixed(1) : "0";
            return (
              <Card key={dir} data-testid={`direction-card-${dir.toLowerCase()}`}>
                <CardContent className="p-4">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs text-muted-foreground font-medium uppercase tracking-wider">{dir}</span>
                    {dir === "LONG" ? <TrendingUp className="w-4 h-4 text-emerald-500" /> : <TrendingDown className="w-4 h-4 text-red-500" />}
                  </div>
                  <div className="flex items-baseline gap-2">
                    <span className="text-2xl font-bold">{wr}%</span>
                    <span className="text-xs text-muted-foreground">win rate</span>
                  </div>
                  <div className="flex items-center gap-2 mt-2">
                    <ProgressBar value={parseFloat(wr)} />
                    <span className="text-xs text-muted-foreground whitespace-nowrap">{data.wins}/{resolved} · {data.total} total</span>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-2">
              <Filter className="w-4 h-4 text-muted-foreground" />
              <CardTitle className="text-base font-medium">Archived Signals</CardTitle>
            </div>
            {hasFilters && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => { setStrategyFilter("all"); setDirectionFilter("all"); setOutcomeFilter("all"); }}
                data-testid="button-clear-backtest-filters"
              >
                <X className="w-3 h-3 mr-1" /> Clear
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="pb-3">
          <div className="flex flex-wrap gap-3">
            <Select value={strategyFilter} onValueChange={setStrategyFilter}>
              <SelectTrigger className="w-[180px]" data-testid="select-backtest-strategy">
                <SelectValue placeholder="Strategy" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Strategies</SelectItem>
                <SelectItem value="TREND_CONTINUATION">Trend Continuation</SelectItem>
                <SelectItem value="RANGE_BREAKOUT">Range Breakout</SelectItem>
              </SelectContent>
            </Select>
            <Select value={directionFilter} onValueChange={setDirectionFilter}>
              <SelectTrigger className="w-[140px]" data-testid="select-backtest-direction">
                <SelectValue placeholder="Direction" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Directions</SelectItem>
                <SelectItem value="LONG">Long</SelectItem>
                <SelectItem value="SHORT">Short</SelectItem>
              </SelectContent>
            </Select>
            <Select value={outcomeFilter} onValueChange={setOutcomeFilter}>
              <SelectTrigger className="w-[140px]" data-testid="select-backtest-outcome">
                <SelectValue placeholder="Outcome" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Outcomes</SelectItem>
                <SelectItem value="WIN">Win</SelectItem>
                <SelectItem value="LOSS">Loss</SelectItem>
                <SelectItem value="MISSED">Missed</SelectItem>
                <SelectItem value="PENDING">Pending</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          {signalsLoading ? (
            <div className="p-4 space-y-3">
              {[1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-14 w-full" />)}
            </div>
          ) : !signals?.length ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <BarChart3 className="w-10 h-10 text-muted-foreground mb-3" />
              <p className="text-sm text-muted-foreground">No archived signals yet</p>
              <p className="text-xs text-muted-foreground mt-1">Signals are archived after 1 hour or when you mark them as Taken / Not Taken</p>
            </div>
          ) : (
            <div className="divide-y">
              {signals.map((sig) => {
                const reason = (sig.reasonJson ?? {}) as Record<string, any>;
                const hasLevels = reason.entryPrice != null;
                const isExpanded = expandedId === sig.id;
                return (
                  <div key={sig.id} data-testid={`backtest-row-${sig.id}`}>
                    <div
                      className="flex items-center justify-between p-4 gap-3 cursor-pointer hover-elevate"
                      onClick={() => setExpandedId(isExpanded ? null : sig.id)}
                      data-testid={`backtest-toggle-${sig.id}`}
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div className={`flex items-center justify-center w-9 h-9 rounded-md shrink-0 ${sig.direction === "LONG" ? "bg-emerald-500/10 text-emerald-500 dark:bg-emerald-500/20" : "bg-red-500/10 text-red-500 dark:bg-red-500/20"}`}>
                          {sig.direction === "LONG" ? <TrendingUp className="w-4 h-4" /> : <TrendingDown className="w-4 h-4" />}
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <Link href={`/instruments/${sig.instrument.canonicalSymbol}`}>
                              <span className="text-sm font-semibold hover:underline" onClick={(e) => e.stopPropagation()}>{sig.instrument.canonicalSymbol}</span>
                            </Link>
                            <Badge variant="secondary" className="text-[10px]">{sig.strategy.replace(/_/g, " ")}</Badge>
                            <Badge
                              variant="outline"
                              className={`text-[10px] ${sig.status === "TAKEN" ? "border-emerald-500/50 text-emerald-500" : sig.status === "NOT_TAKEN" ? "border-muted-foreground/50" : ""}`}
                            >
                              {sig.status.replace(/_/g, " ")}
                            </Badge>
                          </div>
                          <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground flex-wrap">
                            <span>{sig.timeframe}</span>
                            <span>{new Date(sig.detectedAt).toLocaleString()}</span>
                            {hasLevels && (
                              <span className="hidden sm:inline">
                                Entry {formatPrice(reason.entryPrice)} · <span className="text-red-400">SL {formatPrice(reason.stopLoss)}</span> · <span className="text-emerald-400">TP {formatPrice(reason.takeProfit)}</span>
                                {settings && reason.stopDistance > 0 && (() => {
                                  const ps = calcPositionSize(settings.accountBalance, settings.riskPercent, reason.stopDistance, reason.entryPrice, sig.instrument.assetClass);
                                  const display = sig.instrument.assetClass === "FOREX" ? ps.units.toFixed(2) + " lots" : (ps.units < 1 ? ps.units.toFixed(6) : ps.units.toFixed(2)) + " units";
                                  return <> · <Scale className="w-3 h-3 inline" /> {display}</>;
                                })()}
                              </span>
                            )}
                          </div>
                          <SummaryLine text={sig.summaryText} />
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <ScoreBadge score={sig.score} />
                        <OutcomeBadge outcome={sig.outcome ?? "PENDING"} />
                        {isExpanded ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
                      </div>
                    </div>

                    {isExpanded && (
                      <div className="px-4 pb-4" data-testid={`backtest-detail-${sig.id}`}>
                        <div className="rounded-md border p-4 bg-muted/30 space-y-3">
                          <div className="flex items-center justify-end">
                            <DeepDiveButton signalId={sig.id} />
                          </div>
                          <SignalJournal
                            signalId={sig.id}
                            initialNotes={sig.notes}
                            initialConfidence={sig.confidence}
                            initialTags={sig.tags}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function calcPositionSize(accountBalance: number, riskPercent: number, stopDistance: number, entryPrice: number, assetClass: string) {
  const riskAmount = (accountBalance * riskPercent) / 100;
  if (assetClass === "FOREX") {
    const isJpy = entryPrice > 50;
    const pipSize = isJpy ? 0.01 : 0.0001;
    const pipsAtRisk = stopDistance / pipSize;
    const pipValuePerLot = isJpy ? (0.01 / entryPrice) * 100000 : 10;
    const lots = riskAmount / (pipsAtRisk * pipValuePerLot);
    return { units: lots, label: "lots", riskAmount };
  }
  if (assetClass === "METAL") {
    const contractSize = entryPrice > 100 ? 100 : 5000;
    const lots = riskAmount / (stopDistance * contractSize);
    return { units: lots, label: "lots", riskAmount };
  }
  const units = riskAmount / stopDistance;
  return { units, label: "units", riskAmount };
}

function formatPrice(value: number | string | undefined): string {
  if (value == null) return "\u2014";
  const num = typeof value === "string" ? parseFloat(value) : value;
  if (isNaN(num)) return "\u2014";
  if (Math.abs(num) >= 100) return num.toFixed(2);
  if (Math.abs(num) >= 1) return num.toFixed(4);
  return num.toFixed(5);
}

function StatCard({ title, value, subtitle, icon, loading, highlight }: {
  title: string;
  value: string | undefined;
  subtitle: string;
  icon: React.ReactNode;
  loading: boolean;
  highlight?: boolean;
}) {
  return (
    <Card data-testid={`stat-card-${title.toLowerCase().replace(/\s/g, "-")}`}>
      <CardContent className="p-4">
        <div className="flex items-center justify-between gap-1 mb-2">
          <span className="text-xs text-muted-foreground font-medium uppercase tracking-wider">{title}</span>
          <div className="text-muted-foreground">{icon}</div>
        </div>
        {loading ? (
          <Skeleton className="h-7 w-20" />
        ) : (
          <div className={`text-2xl font-bold tracking-tight ${highlight ? "text-emerald-500" : ""}`}>{value}</div>
        )}
        <p className="text-xs text-muted-foreground mt-1">{subtitle}</p>
      </CardContent>
    </Card>
  );
}

function ProgressBar({ value }: { value: number }) {
  const clampedValue = Math.min(100, Math.max(0, value));
  const color = clampedValue >= 60 ? "bg-emerald-500" : clampedValue >= 40 ? "bg-amber-500" : "bg-red-500";
  return (
    <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
      <div className={`h-full rounded-full ${color}`} style={{ width: `${clampedValue}%` }} />
    </div>
  );
}

function OutcomeBadge({ outcome }: { outcome: string }) {
  const config: Record<string, { color: string; icon: React.ReactNode }> = {
    WIN: { color: "bg-emerald-500/10 text-emerald-500 dark:bg-emerald-500/20", icon: <Trophy className="w-3 h-3" /> },
    LOSS: { color: "bg-red-500/10 text-red-500 dark:bg-red-500/20", icon: <XCircle className="w-3 h-3" /> },
    MISSED: { color: "bg-muted text-muted-foreground", icon: <HelpCircle className="w-3 h-3" /> },
    PENDING: { color: "bg-amber-500/10 text-amber-500 dark:bg-amber-500/20", icon: <HelpCircle className="w-3 h-3" /> },
  };
  const c = config[outcome] || config.MISSED;
  return (
    <span className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium ${c.color}`} data-testid={`outcome-badge-${outcome.toLowerCase()}`}>
      {c.icon}
      {outcome}
    </span>
  );
}

function ScoreBadge({ score }: { score: number }) {
  let color = "bg-muted text-muted-foreground";
  if (score >= 70) color = "bg-emerald-500/10 text-emerald-500 dark:bg-emerald-500/20";
  else if (score >= 50) color = "bg-amber-500/10 text-amber-500 dark:bg-amber-500/20";
  else color = "bg-red-500/10 text-red-500 dark:bg-red-500/20";
  return (
    <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ${color}`}>
      {score}
    </span>
  );
}

function ReclassifyMissedDialog({ missedCount }: { missedCount: number }) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [windowHours, setWindowHours] = useState(24);
  const [adminToken, setAdminToken] = useState<string>(
    typeof window !== "undefined" ? localStorage.getItem("backfillAdminToken") ?? "" : "",
  );
  const [report, setReport] = useState<ReclassifyReport | null>(null);

  const mutation = useMutation({
    mutationFn: async (hours: number): Promise<ReclassifyReport> => {
      if (typeof window !== "undefined" && adminToken.trim()) {
        localStorage.setItem("backfillAdminToken", adminToken.trim());
      }
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (adminToken.trim()) headers["x-admin-token"] = adminToken.trim();
      const res = await fetch("/api/admin/reclassify-missed", {
        method: "POST",
        headers,
        credentials: "include",
        body: JSON.stringify({ windowHours: hours }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => res.statusText);
        throw new Error(`${res.status}: ${text || res.statusText}`);
      }
      return res.json();
    },
    onSuccess: (data) => {
      setReport(data);
      queryClient.invalidateQueries({ queryKey: ["/api/backtest/stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/backtest/signals"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard/stats"] });
      toast({
        title: "Reclassification complete",
        description: `Flipped ${data.flippedToWin} → WIN, ${data.flippedToLoss} → LOSS, ${data.stillMissed} still MISSED.`,
      });
    },
    onError: (err: any) => {
      toast({
        title: "Reclassify failed",
        description: err?.message ?? "Unknown error",
        variant: "destructive",
      });
    },
  });

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) setReport(null); }}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" data-testid="button-open-reclassify-missed">
          <RefreshCcw className="w-4 h-4 mr-2" />
          Reclassify MISSED ({missedCount})
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg" data-testid="dialog-reclassify-missed">
        <DialogHeader>
          <DialogTitle>Reclassify MISSED Signals</DialogTitle>
          <DialogDescription>
            Walks each MISSED signal's post-detection candles within the chosen window and
            checks whether TP or SL was actually touched. Outcomes flip to WIN/LOSS when found.
            Useful after a candle backfill.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="reclassify-window">Window (hours)</Label>
            <Input
              id="reclassify-window"
              type="number"
              min={1}
              max={720}
              value={windowHours}
              onChange={(e) => setWindowHours(Math.max(1, Math.min(720, parseInt(e.target.value) || 1)))}
              data-testid="input-reclassify-window"
            />
            <p className="text-xs text-muted-foreground">
              How far past each signal's detection time to walk for TP/SL touches. Range 1–720.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="reclassify-admin-token">Admin Token (if required)</Label>
            <Input
              id="reclassify-admin-token"
              type="password"
              placeholder="x-admin-token header value"
              value={adminToken}
              onChange={(e) => setAdminToken(e.target.value)}
              data-testid="input-reclassify-admin-token"
            />
            <p className="text-xs text-muted-foreground">
              Stored in your browser only. Leave blank if ADMIN_TOKEN is not set on the server.
            </p>
          </div>

          {report && (
            <div className="rounded-md border bg-muted/30 p-3 text-sm space-y-1" data-testid="text-reclassify-report">
              <div className="flex justify-between"><span className="text-muted-foreground">Scanned</span><span className="font-mono">{report.scanned}</span></div>
              <div className="flex justify-between"><span className="text-emerald-500">→ WIN</span><span className="font-mono">{report.flippedToWin}</span></div>
              <div className="flex justify-between"><span className="text-red-500">→ LOSS</span><span className="font-mono">{report.flippedToLoss}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Still MISSED</span><span className="font-mono">{report.stillMissed}</span></div>
              {report.skippedNoLevels > 0 && (
                <div className="flex justify-between text-xs text-muted-foreground"><span>Skipped (no TP/SL)</span><span className="font-mono">{report.skippedNoLevels}</span></div>
              )}
              {report.skippedNoCandles > 0 && (
                <div className="flex justify-between text-xs text-muted-foreground"><span>Skipped (no candles)</span><span className="font-mono">{report.skippedNoCandles}</span></div>
              )}
              {Object.keys(report.byStrategy).length > 0 && (
                <div className="pt-2 mt-2 border-t space-y-1">
                  {Object.entries(report.byStrategy).map(([strat, b]) => (
                    <div key={strat} className="flex justify-between text-xs">
                      <span className="text-muted-foreground">{strat.replace(/_/g, " ")}</span>
                      <span className="font-mono">{b.flippedToWin}W / {b.flippedToLoss}L / {b.stillMissed}M</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} data-testid="button-reclassify-close">Close</Button>
          <Button
            onClick={() => mutation.mutate(windowHours)}
            disabled={mutation.isPending || missedCount === 0}
            data-testid="button-reclassify-run"
          >
            {mutation.isPending ? "Walking candles…" : "Run Reclassification"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
