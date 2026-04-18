import { useState, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TrendingUp, TrendingDown, Zap, Filter, X, ChevronDown, ChevronUp, Target, ShieldAlert, CircleDollarSign, Crosshair, Check, XCircle, Scale, Clock, Eye } from "lucide-react";
import { Link } from "wouter";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { SignalWithInstrument, Settings } from "@shared/schema";
import { SignalJournal, SummaryLine, DeepDiveButton } from "@/components/signal-journal";

const MONITORING_THRESHOLD_MS = 60 * 60 * 1000;

export default function SignalsPage() {
  const [activeTab, setActiveTab] = useState("active");
  const [strategyFilter, setStrategyFilter] = useState<string>("all");
  const [directionFilter, setDirectionFilter] = useState<string>("all");
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const { data: allActiveSignals, isLoading } = useQuery<SignalWithInstrument[]>({
    queryKey: ["/api/signals", "?status=active"],
    refetchInterval: 15000,
  });

  const { data: settings } = useQuery<Settings>({ queryKey: ["/api/settings"] });

  const actionMutation = useMutation({
    mutationFn: async ({ id, action }: { id: number; action: string }) => {
      await apiRequest("POST", `/api/signals/${id}/action`, { action });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/signals"] });
      queryClient.invalidateQueries({ queryKey: ["/api/backtest/signals"] });
      queryClient.invalidateQueries({ queryKey: ["/api/backtest/stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard/stats"] });
    },
  });

  const { activeSignals, monitoringSignals } = useMemo(() => {
    if (!allActiveSignals) return { activeSignals: [], monitoringSignals: [] };
    const now = Date.now();
    const active: SignalWithInstrument[] = [];
    const monitoring: SignalWithInstrument[] = [];
    for (const sig of allActiveSignals) {
      const age = now - new Date(sig.detectedAt).getTime();
      if (age > MONITORING_THRESHOLD_MS) {
        monitoring.push(sig);
      } else {
        active.push(sig);
      }
    }
    return { activeSignals: active, monitoringSignals: monitoring };
  }, [allActiveSignals]);

  const filterSignals = (list: SignalWithInstrument[]) => {
    return list.filter((sig) => {
      if (strategyFilter !== "all" && sig.strategy !== strategyFilter) return false;
      if (directionFilter !== "all" && sig.direction !== directionFilter) return false;
      return true;
    });
  };

  const displaySignals = activeTab === "active" ? filterSignals(activeSignals) : filterSignals(monitoringSignals);
  const hasFilters = strategyFilter !== "all" || directionFilter !== "all";
  const evalWindow = settings?.signalEvalWindowHours ?? 4;

  return (
    <div className="flex flex-col gap-6 p-6 max-w-7xl mx-auto">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight" data-testid="text-signals-title">Signals</h1>
        <p className="text-sm text-muted-foreground mt-1">Trading setups detected by the scanner</p>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <div className="flex items-center justify-between flex-wrap gap-3">
          <TabsList data-testid="tabs-signal-view">
            <TabsTrigger value="active" data-testid="tab-active" className="gap-1.5">
              <Zap className="w-3.5 h-3.5" />
              Active
              {activeSignals.length > 0 && (
                <Badge variant="secondary" className="text-[10px] ml-0.5">{activeSignals.length}</Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="monitoring" data-testid="tab-monitoring" className="gap-1.5">
              <Eye className="w-3.5 h-3.5" />
              Monitoring
              {monitoringSignals.length > 0 && (
                <Badge variant="secondary" className="text-[10px] ml-0.5">{monitoringSignals.length}</Badge>
              )}
            </TabsTrigger>
          </TabsList>

          <div className="flex items-center gap-2 flex-wrap">
            <Select value={strategyFilter} onValueChange={setStrategyFilter}>
              <SelectTrigger className="w-[170px]" data-testid="select-strategy-filter">
                <SelectValue placeholder="Strategy" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Strategies</SelectItem>
                <SelectItem value="TREND_CONTINUATION">Trend Continuation</SelectItem>
                <SelectItem value="RANGE_BREAKOUT">Range Breakout</SelectItem>
              </SelectContent>
            </Select>
            <Select value={directionFilter} onValueChange={setDirectionFilter}>
              <SelectTrigger className="w-[140px]" data-testid="select-direction-filter">
                <SelectValue placeholder="Direction" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Directions</SelectItem>
                <SelectItem value="LONG">Long</SelectItem>
                <SelectItem value="SHORT">Short</SelectItem>
              </SelectContent>
            </Select>
            {hasFilters && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => { setStrategyFilter("all"); setDirectionFilter("all"); }}
                data-testid="button-clear-filters"
              >
                <X className="w-3 h-3 mr-1" /> Clear
              </Button>
            )}
          </div>
        </div>

        <TabsContent value="active" className="mt-4">
          <Card>
            <CardContent className="p-0">
              {isLoading ? (
                <div className="p-4 space-y-3">
                  {[1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-14 w-full" />)}
                </div>
              ) : !displaySignals.length ? (
                <div className="flex flex-col items-center justify-center py-16 text-center">
                  <Zap className="w-10 h-10 text-muted-foreground mb-3" />
                  <p className="text-sm text-muted-foreground">No active signals right now</p>
                  <p className="text-xs text-muted-foreground mt-1">New signals appear here as the scanner detects setups</p>
                </div>
              ) : (
                <SignalList
                  signals={displaySignals}
                  expandedId={expandedId}
                  setExpandedId={setExpandedId}
                  actionMutation={actionMutation}
                  settings={settings}
                />
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="monitoring" className="mt-4 space-y-4">
          <div className="rounded-md bg-muted/50 p-3 flex items-start gap-2">
            <Clock className="w-4 h-4 text-muted-foreground mt-0.5 shrink-0" />
            <div>
              <p className="text-xs font-medium">Signals being monitored for TP/SL resolution</p>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                These signals are older than 1 hour and haven't hit their Take Profit or Stop Loss yet. 
                The scanner continues checking each tick. Signals that don't resolve within the {evalWindow}-hour evaluation window will be classified as MISSED (stalled momentum).
              </p>
            </div>
          </div>
          <Card>
            <CardContent className="p-0">
              {isLoading ? (
                <div className="p-4 space-y-3">
                  {[1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-14 w-full" />)}
                </div>
              ) : !displaySignals.length ? (
                <div className="flex flex-col items-center justify-center py-16 text-center">
                  <Eye className="w-10 h-10 text-muted-foreground mb-3" />
                  <p className="text-sm text-muted-foreground">No signals currently being monitored</p>
                  <p className="text-xs text-muted-foreground mt-1">Signals that haven't resolved within 1 hour will appear here for tracking</p>
                </div>
              ) : (
                <SignalList
                  signals={displaySignals}
                  expandedId={expandedId}
                  setExpandedId={setExpandedId}
                  actionMutation={actionMutation}
                  settings={settings}
                  showAge
                />
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function SignalList({ signals, expandedId, setExpandedId, actionMutation, settings, showAge }: {
  signals: SignalWithInstrument[];
  expandedId: number | null;
  setExpandedId: (id: number | null) => void;
  actionMutation: any;
  settings?: Settings;
  showAge?: boolean;
}) {
  return (
    <div className="divide-y">
      {signals.map((sig) => {
        const reason = (sig.reasonJson ?? {}) as Record<string, any>;
        const isExpanded = expandedId === sig.id;
        const hasLevels = reason.entryPrice != null;
        const ageMs = Date.now() - new Date(sig.detectedAt).getTime();
        const ageHours = Math.floor(ageMs / (60 * 60 * 1000));
        const ageMinutes = Math.floor((ageMs % (60 * 60 * 1000)) / (60 * 1000));

        return (
          <div key={sig.id} data-testid={`signal-row-${sig.id}`}>
            <div
              className="flex items-center justify-between p-4 cursor-pointer hover-elevate"
              onClick={() => setExpandedId(isExpanded ? null : sig.id)}
              data-testid={`signal-toggle-${sig.id}`}
            >
              <div className="flex items-center gap-3 min-w-0">
                <div className={`flex items-center justify-center w-9 h-9 rounded-md shrink-0 ${sig.direction === "LONG" ? "bg-emerald-500/10 text-emerald-500 dark:bg-emerald-500/20" : "bg-red-500/10 text-red-500 dark:bg-red-500/20"}`}>
                  {sig.direction === "LONG" ? <TrendingUp className="w-4 h-4" /> : <TrendingDown className="w-4 h-4" />}
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Link href={`/instruments/${sig.instrument.canonicalSymbol}`}>
                      <span className="text-sm font-semibold hover:underline" data-testid={`link-symbol-${sig.instrument.canonicalSymbol}`}>
                        {sig.instrument.canonicalSymbol}
                      </span>
                    </Link>
                    <Badge variant="secondary" className="text-[10px]">
                      {sig.strategy.replace(/_/g, " ")}
                    </Badge>
                    <Badge
                      variant={sig.status === "NEW" ? "default" : sig.status === "TAKEN" ? "default" : sig.status === "ALERTED" ? "secondary" : "outline"}
                      className={`text-[10px] ${sig.status === "TAKEN" ? "bg-emerald-500/80" : sig.status === "EXPIRED" ? "bg-muted" : ""}`}
                    >
                      {sig.status.replace(/_/g, " ")}
                    </Badge>
                    {showAge && (
                      <span className="text-[10px] text-amber-500 dark:text-amber-400 flex items-center gap-0.5">
                        <Clock className="w-3 h-3" />
                        {ageHours > 0 ? `${ageHours}h ${ageMinutes}m` : `${ageMinutes}m`}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground flex-wrap">
                    <span>{sig.timeframe}</span>
                    <span>{new Date(sig.detectedAt).toLocaleString()}</span>
                    {hasLevels && (
                      <span className="hidden sm:inline">
                        Entry: {formatPrice(reason.entryPrice)}
                      </span>
                    )}
                  </div>
                  <SummaryLine text={sig.summaryText} />
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {hasLevels && (
                  <div className="hidden md:flex items-center gap-3 mr-3 text-xs">
                    <span className="text-red-400">SL {formatPrice(reason.stopLoss)}</span>
                    <span className="text-emerald-400">TP {formatPrice(reason.takeProfit)}</span>
                  </div>
                )}
                <ScoreBadge score={sig.score} />
                <Badge variant={sig.direction === "LONG" ? "default" : "destructive"} className="text-[10px]">
                  {sig.direction}
                </Badge>
                {isExpanded ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
              </div>
            </div>

            {isExpanded && (
              <div className="px-4 pb-4" data-testid={`signal-detail-${sig.id}`}>
                <div className="rounded-md border p-4 space-y-4 bg-muted/30">
                  {hasLevels && (
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                      <LevelCard
                        icon={<Crosshair className="w-3.5 h-3.5" />}
                        label="Entry Price"
                        value={formatPrice(reason.entryPrice)}
                        color="text-foreground"
                      />
                      <LevelCard
                        icon={<ShieldAlert className="w-3.5 h-3.5" />}
                        label="Stop Loss"
                        value={formatPrice(reason.stopLoss)}
                        color="text-red-400"
                      />
                      <LevelCard
                        icon={<Target className="w-3.5 h-3.5" />}
                        label="Take Profit"
                        value={formatPrice(reason.takeProfit)}
                        color="text-emerald-400"
                      />
                      <LevelCard
                        icon={<CircleDollarSign className="w-3.5 h-3.5" />}
                        label="Risk : Reward"
                        value={reason.riskRewardRatio || "\u2014"}
                        color="text-foreground"
                      />
                    </div>
                  )}

                  {hasLevels && settings && reason.stopDistance != null && reason.stopDistance > 0 && (
                    <PositionSizeCard
                      accountBalance={settings.accountBalance}
                      riskPercent={settings.riskPercent}
                      stopDistance={reason.stopDistance}
                      entryPrice={reason.entryPrice}
                      assetClass={sig.instrument.assetClass}
                    />
                  )}

                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-2 text-xs">
                    {reason.atr != null && (
                      <DetailItem label="ATR" value={formatPrice(reason.atr)} />
                    )}
                    {reason.stopDistance != null && (
                      <DetailItem label="Stop Distance" value={formatPrice(reason.stopDistance)} />
                    )}
                    {reason.adx != null && (
                      <DetailItem label="ADX" value={String(reason.adx)} />
                    )}
                    {reason.ema21Zone != null && (
                      <DetailItem label="EMA21 Zone" value={formatPrice(reason.ema21Zone)} />
                    )}
                    {reason.ema55Zone != null && (
                      <DetailItem label="EMA55 Zone" value={formatPrice(reason.ema55Zone)} />
                    )}
                    {reason.rangeHigh != null && (
                      <DetailItem label="Range High" value={formatPrice(reason.rangeHigh)} />
                    )}
                    {reason.rangeLow != null && (
                      <DetailItem label="Range Low" value={formatPrice(reason.rangeLow)} />
                    )}
                    {reason.bbWidth != null && (
                      <DetailItem label="BB Width" value={formatPrice(reason.bbWidth)} />
                    )}
                  </div>

                  <div>
                    <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-2">Signal Reasoning</p>
                    <div className="flex flex-wrap gap-1.5">
                      {reason.bias && <ReasonChip label="Bias" value={String(reason.bias)} />}
                      {reason.emaStack && <ReasonChip label="EMA Stack" value={String(reason.emaStack)} />}
                      {reason.pullback && <ReasonChip label="Pullback" value={String(reason.pullback)} />}
                      {reason.macd && <ReasonChip label="MACD" value={String(reason.macd)} />}
                      {reason.breakout && <ReasonChip label="Breakout" value={String(reason.breakout)} />}
                    </div>
                  </div>

                  <div className="flex items-center gap-2 pt-2 border-t flex-wrap">
                    {sig.status === "NEW" ? (
                      <>
                        <span className="text-xs text-muted-foreground mr-auto">Mark this signal:</span>
                        <Button
                          size="sm"
                          variant="default"
                          disabled={actionMutation.isPending}
                          onClick={(e) => { e.stopPropagation(); actionMutation.mutate({ id: sig.id, action: "TAKEN" }); }}
                          data-testid={`button-taken-${sig.id}`}
                        >
                          <Check className="w-3 h-3 mr-1" /> Taken
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={actionMutation.isPending}
                          onClick={(e) => { e.stopPropagation(); actionMutation.mutate({ id: sig.id, action: "NOT_TAKEN" }); }}
                          data-testid={`button-not-taken-${sig.id}`}
                        >
                          <XCircle className="w-3 h-3 mr-1" /> Not Taken
                        </Button>
                      </>
                    ) : (
                      <span className="text-xs text-muted-foreground mr-auto">Actions:</span>
                    )}
                    <DeepDiveButton signalId={sig.id} />
                  </div>

                  <SignalJournal
                    signalId={sig.id}
                    initialNotes={sig.notes}
                    initialConfidence={sig.confidence}
                    initialTags={sig.tags}
                  />

                  {sig.outcome && (
                    <div className="flex items-center gap-2 pt-2 border-t">
                      <span className="text-xs text-muted-foreground">Outcome:</span>
                      <OutcomeBadge outcome={sig.outcome} />
                      {sig.outcomePrice != null && (
                        <span className="text-xs text-muted-foreground">@ {formatPrice(sig.outcomePrice)}</span>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function formatPrice(value: number | string | undefined): string {
  if (value == null) return "\u2014";
  const num = typeof value === "string" ? parseFloat(value) : value;
  if (isNaN(num)) return "\u2014";
  if (Math.abs(num) >= 100) return num.toFixed(2);
  if (Math.abs(num) >= 1) return num.toFixed(4);
  return num.toFixed(5);
}

function LevelCard({ icon, label, value, color }: { icon: React.ReactNode; label: string; value: string; color: string }) {
  return (
    <div className="rounded-md border p-3 bg-background" data-testid={`level-${label.toLowerCase().replace(/\s/g, "-")}`}>
      <div className="flex items-center gap-1.5 mb-1">
        <span className="text-muted-foreground">{icon}</span>
        <span className="text-[11px] text-muted-foreground font-medium">{label}</span>
      </div>
      <span className={`text-sm font-semibold ${color}`}>{value}</span>
    </div>
  );
}

function DetailItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between py-1" data-testid={`detail-${label.toLowerCase().replace(/\s/g, "-")}`}>
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}

function ReasonChip({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] bg-background">
      <span className="font-medium">{label}:</span>
      <span className="text-muted-foreground">{value}</span>
    </span>
  );
}

function OutcomeBadge({ outcome }: { outcome: string }) {
  const map: Record<string, string> = {
    WIN: "bg-emerald-500/10 text-emerald-500 dark:bg-emerald-500/20",
    LOSS: "bg-red-500/10 text-red-500 dark:bg-red-500/20",
    MISSED: "bg-muted text-muted-foreground",
  };
  return (
    <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ${map[outcome] || map.MISSED}`} data-testid={`outcome-${outcome.toLowerCase()}`}>
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

function PositionSizeCard({ accountBalance, riskPercent, stopDistance, entryPrice, assetClass }: {
  accountBalance: number;
  riskPercent: number;
  stopDistance: number;
  entryPrice: number;
  assetClass: string;
}) {
  const ps = calcPositionSize(accountBalance, riskPercent, stopDistance, entryPrice, assetClass);
  const unitsDisplay = assetClass === "FOREX"
    ? ps.units.toFixed(2)
    : ps.units < 1 ? ps.units.toFixed(6) : ps.units.toFixed(2);

  return (
    <div className="rounded-md border bg-background p-3" data-testid="position-size-card">
      <div className="flex items-center gap-2 mb-2">
        <Scale className="w-3.5 h-3.5 text-muted-foreground" />
        <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">Position Sizing</span>
      </div>
      <div className="grid grid-cols-3 gap-3 text-xs">
        <div>
          <span className="text-muted-foreground">Risk Amount</span>
          <p className="font-semibold text-sm" data-testid="text-risk-amount">${ps.riskAmount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
        </div>
        <div>
          <span className="text-muted-foreground">Position Size</span>
          <p className="font-semibold text-sm" data-testid="text-position-size">{unitsDisplay} {ps.label}</p>
        </div>
        <div>
          <span className="text-muted-foreground">Settings</span>
          <p className="text-muted-foreground">${accountBalance.toLocaleString()} / {riskPercent}%</p>
        </div>
      </div>
    </div>
  );
}
