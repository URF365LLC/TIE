import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Activity, Zap, BarChart3, Clock, Play, TrendingUp, TrendingDown, AlertCircle } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Link } from "wouter";
import type { SignalWithInstrument, ScanRun } from "@shared/schema";

export default function Dashboard() {
  const { toast } = useToast();

  const { data: stats, isLoading: statsLoading } = useQuery<{
    totalInstruments: number;
    enabledInstruments: number;
    totalSignals: number;
    newSignals: number;
    lastScan: ScanRun | null;
    scanEnabled: boolean;
  }>({
    queryKey: ["/api/dashboard/stats"],
    refetchInterval: 15000,
  });

  const { data: recentSignals, isLoading: signalsLoading } = useQuery<SignalWithInstrument[]>({
    queryKey: ["/api/signals", "?limit=10&status=NEW"],
    refetchInterval: 15000,
  });

  const { data: recentScans, isLoading: scansLoading } = useQuery<ScanRun[]>({
    queryKey: ["/api/scan/runs", "?limit=5"],
    refetchInterval: 15000,
  });

  const triggerScan = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/scan/run");
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Scan triggered", description: "A manual scan has been started." });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard/stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/scan/runs"] });
    },
    onError: (err: Error) => {
      toast({ title: "Scan failed", description: err.message, variant: "destructive" });
    },
  });

  return (
    <div className="flex flex-col gap-6 p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight" data-testid="text-dashboard-title">Dashboard</h1>
          <p className="text-sm text-muted-foreground mt-1">Trading Intelligence Engine overview</p>
        </div>
        <Button
          onClick={() => triggerScan.mutate()}
          disabled={triggerScan.isPending}
          data-testid="button-manual-scan"
        >
          <Play className="w-4 h-4 mr-2" />
          {triggerScan.isPending ? "Scanning..." : "Run Scan"}
        </Button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          title="Instruments"
          value={statsLoading ? undefined : `${stats?.enabledInstruments ?? 0} / ${stats?.totalInstruments ?? 0}`}
          subtitle="enabled / total"
          icon={<BarChart3 className="w-4 h-4" />}
          loading={statsLoading}
        />
        <StatCard
          title="New Signals"
          value={statsLoading ? undefined : String(stats?.newSignals ?? 0)}
          subtitle="awaiting review"
          icon={<Zap className="w-4 h-4" />}
          loading={statsLoading}
          highlight={!!stats?.newSignals && stats.newSignals > 0}
        />
        <StatCard
          title="Total Signals"
          value={statsLoading ? undefined : String(stats?.totalSignals ?? 0)}
          subtitle="all time"
          icon={<Activity className="w-4 h-4" />}
          loading={statsLoading}
        />
        <StatCard
          title="Scanner"
          value={statsLoading ? undefined : stats?.scanEnabled ? "Active" : "Inactive"}
          subtitle={stats?.lastScan?.finishedAt
            ? `Last: ${new Date(stats.lastScan.finishedAt).toLocaleTimeString()}`
            : "No scans yet"}
          icon={<Clock className="w-4 h-4" />}
          loading={statsLoading}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-2">
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-3">
            <CardTitle className="text-base font-medium">Recent Signals</CardTitle>
            <Link href="/signals">
              <Button variant="ghost" size="sm" data-testid="link-view-all-signals">View All</Button>
            </Link>
          </CardHeader>
          <CardContent>
            {signalsLoading ? (
              <div className="space-y-3">
                {[1, 2, 3].map((i) => <Skeleton key={i} className="h-12 w-full" />)}
              </div>
            ) : !recentSignals?.length ? (
              <div className="flex flex-col items-center justify-center py-10 text-center">
                <AlertCircle className="w-8 h-8 text-muted-foreground mb-2" />
                <p className="text-sm text-muted-foreground">No signals detected yet</p>
                <p className="text-xs text-muted-foreground mt-1">Run a scan to detect trading setups</p>
              </div>
            ) : (
              <div className="space-y-2">
                {recentSignals.map((sig) => (
                  <Link key={sig.id} href={`/instruments/${sig.instrument.canonicalSymbol}`}>
                    <div className="flex items-center justify-between p-3 rounded-md bg-card border border-card-border hover-elevate cursor-pointer" data-testid={`signal-row-${sig.id}`}>
                      <div className="flex items-center gap-3">
                        <div className={`flex items-center justify-center w-8 h-8 rounded-md ${sig.direction === "LONG" ? "bg-emerald-500/10 text-emerald-500 dark:bg-emerald-500/20" : "bg-red-500/10 text-red-500 dark:bg-red-500/20"}`}>
                          {sig.direction === "LONG" ? <TrendingUp className="w-4 h-4" /> : <TrendingDown className="w-4 h-4" />}
                        </div>
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium">{sig.instrument.canonicalSymbol}</span>
                            <Badge variant="secondary" className="text-[10px]">{sig.strategy.replace("_", " ")}</Badge>
                          </div>
                          <span className="text-xs text-muted-foreground">{sig.timeframe} · {new Date(sig.detectedAt).toLocaleString()}</span>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <ScoreBadge score={sig.score} />
                        <Badge variant={sig.direction === "LONG" ? "default" : "destructive"} className="text-[10px]">
                          {sig.direction}
                        </Badge>
                      </div>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-medium">Recent Scans</CardTitle>
          </CardHeader>
          <CardContent>
            {scansLoading ? (
              <div className="space-y-3">
                {[1, 2, 3].map((i) => <Skeleton key={i} className="h-10 w-full" />)}
              </div>
            ) : !recentScans?.length ? (
              <div className="flex flex-col items-center justify-center py-10 text-center">
                <Clock className="w-8 h-8 text-muted-foreground mb-2" />
                <p className="text-sm text-muted-foreground">No scans yet</p>
              </div>
            ) : (
              <div className="space-y-2">
                {recentScans.map((scan) => (
                  <div key={scan.id} className="flex items-center justify-between p-3 rounded-md bg-card border border-card-border" data-testid={`scan-row-${scan.id}`}>
                    <div>
                      <span className="text-sm font-medium">{scan.timeframe}</span>
                      <p className="text-xs text-muted-foreground">
                        {new Date(scan.startedAt).toLocaleString()}
                      </p>
                    </div>
                    <Badge
                      variant={scan.status === "completed" ? "default" : scan.status === "running" ? "secondary" : "destructive"}
                      className="text-[10px]"
                    >
                      {scan.status}
                    </Badge>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function StatCard({ title, value, subtitle, icon, loading, highlight }: {
  title: string;
  value?: string;
  subtitle: string;
  icon: React.ReactNode;
  loading: boolean;
  highlight?: boolean;
}) {
  return (
    <Card data-testid={`stat-card-${title.toLowerCase().replace(/\s/g, "-")}`}>
      <CardContent className="p-4">
        <div className="flex items-center justify-between mb-2">
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

function ScoreBadge({ score }: { score: number }) {
  let color = "bg-muted text-muted-foreground";
  if (score >= 70) color = "bg-emerald-500/10 text-emerald-500 dark:bg-emerald-500/20";
  else if (score >= 50) color = "bg-amber-500/10 text-amber-500 dark:bg-amber-500/20";
  else color = "bg-red-500/10 text-red-500 dark:bg-red-500/20";

  return (
    <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ${color}`} data-testid={`score-${score}`}>
      {score}
    </span>
  );
}
