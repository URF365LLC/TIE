import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TrendingUp, TrendingDown, Zap, Filter, X, ChevronDown, ChevronUp, Target, ShieldAlert, CircleDollarSign, Crosshair } from "lucide-react";
import { Link } from "wouter";
import type { SignalWithInstrument } from "@shared/schema";

export default function SignalsPage() {
  const [strategyFilter, setStrategyFilter] = useState<string>("all");
  const [directionFilter, setDirectionFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const queryParams = new URLSearchParams();
  if (strategyFilter !== "all") queryParams.set("strategy", strategyFilter);
  if (directionFilter !== "all") queryParams.set("direction", directionFilter);
  if (statusFilter !== "all") queryParams.set("status", statusFilter);

  const qs = queryParams.toString();
  const { data: signals, isLoading } = useQuery<SignalWithInstrument[]>({
    queryKey: ["/api/signals", qs ? `?${qs}` : ""],
    refetchInterval: 15000,
  });

  const hasFilters = strategyFilter !== "all" || directionFilter !== "all" || statusFilter !== "all";

  return (
    <div className="flex flex-col gap-6 p-6 max-w-7xl mx-auto">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight" data-testid="text-signals-title">Signals</h1>
        <p className="text-sm text-muted-foreground mt-1">Trading setups detected by the scanner</p>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-2">
              <Filter className="w-4 h-4 text-muted-foreground" />
              <CardTitle className="text-base font-medium">Filters</CardTitle>
            </div>
            {hasFilters && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => { setStrategyFilter("all"); setDirectionFilter("all"); setStatusFilter("all"); }}
                data-testid="button-clear-filters"
              >
                <X className="w-3 h-3 mr-1" /> Clear
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-3">
            <Select value={strategyFilter} onValueChange={setStrategyFilter}>
              <SelectTrigger className="w-[180px]" data-testid="select-strategy-filter">
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
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-[140px]" data-testid="select-status-filter">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Status</SelectItem>
                <SelectItem value="NEW">New</SelectItem>
                <SelectItem value="ALERTED">Alerted</SelectItem>
                <SelectItem value="IGNORED">Ignored</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4 space-y-3">
              {[1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-14 w-full" />)}
            </div>
          ) : !signals?.length ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <Zap className="w-10 h-10 text-muted-foreground mb-3" />
              <p className="text-sm text-muted-foreground">No signals match your filters</p>
              {hasFilters && (
                <Button variant="ghost" size="sm" className="mt-2" onClick={() => { setStrategyFilter("all"); setDirectionFilter("all"); setStatusFilter("all"); }}>
                  Clear filters
                </Button>
              )}
            </div>
          ) : (
            <div className="divide-y">
              {signals.map((sig) => {
                const reason = (sig.reasonJson ?? {}) as Record<string, any>;
                const isExpanded = expandedId === sig.id;
                const hasLevels = reason.entryPrice != null;

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
                              variant={sig.status === "NEW" ? "default" : sig.status === "ALERTED" ? "secondary" : "outline"}
                              className="text-[10px]"
                            >
                              {sig.status}
                            </Badge>
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
                                value={reason.riskRewardRatio || "—"}
                                color="text-foreground"
                              />
                            </div>
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

function formatPrice(value: number | string | undefined): string {
  if (value == null) return "—";
  const num = typeof value === "string" ? parseFloat(value) : value;
  if (isNaN(num)) return "—";
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
