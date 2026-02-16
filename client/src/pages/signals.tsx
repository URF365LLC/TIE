import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TrendingUp, TrendingDown, Zap, Filter, X } from "lucide-react";
import { Link } from "wouter";
import type { SignalWithInstrument } from "@shared/schema";

export default function SignalsPage() {
  const [strategyFilter, setStrategyFilter] = useState<string>("all");
  const [directionFilter, setDirectionFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");

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
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="table-signals">
                <thead>
                  <tr className="border-b text-left">
                    <th className="p-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Symbol</th>
                    <th className="p-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Direction</th>
                    <th className="p-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Strategy</th>
                    <th className="p-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Timeframe</th>
                    <th className="p-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Score</th>
                    <th className="p-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Status</th>
                    <th className="p-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">Detected</th>
                  </tr>
                </thead>
                <tbody>
                  {signals.map((sig) => (
                    <tr key={sig.id} className="border-b last:border-0 hover-elevate" data-testid={`signal-row-${sig.id}`}>
                      <td className="p-3">
                        <Link href={`/instruments/${sig.instrument.canonicalSymbol}`}>
                          <span className="font-medium hover:underline cursor-pointer" data-testid={`link-symbol-${sig.instrument.canonicalSymbol}`}>
                            {sig.instrument.canonicalSymbol}
                          </span>
                        </Link>
                      </td>
                      <td className="p-3">
                        <div className="flex items-center gap-1.5">
                          {sig.direction === "LONG" ? (
                            <TrendingUp className="w-3.5 h-3.5 text-emerald-500" />
                          ) : (
                            <TrendingDown className="w-3.5 h-3.5 text-red-500" />
                          )}
                          <span className={sig.direction === "LONG" ? "text-emerald-500" : "text-red-500"}>
                            {sig.direction}
                          </span>
                        </div>
                      </td>
                      <td className="p-3">
                        <Badge variant="secondary" className="text-[10px]">
                          {sig.strategy.replace("_", " ")}
                        </Badge>
                      </td>
                      <td className="p-3 text-muted-foreground">{sig.timeframe}</td>
                      <td className="p-3">
                        <ScoreBadge score={sig.score} />
                      </td>
                      <td className="p-3">
                        <Badge
                          variant={sig.status === "NEW" ? "default" : sig.status === "ALERTED" ? "secondary" : "outline"}
                          className="text-[10px]"
                        >
                          {sig.status}
                        </Badge>
                      </td>
                      <td className="p-3 text-muted-foreground text-xs">
                        {new Date(sig.detectedAt).toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
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
