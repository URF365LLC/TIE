import { useState, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Loader2, Beaker } from "lucide-react";
import type { StrategyParameters, StrategyParamsConfig } from "@shared/schema";

interface ReplayResult {
  paramSetId: number;
  paramSetVersion: number;
  totalSignals: number;
  wins: number;
  losses: number;
  missed: number;
  winRate: number | null;
  expectancyR: number | null;
  durationMs: number;
  bySymbol: Array<{ symbol: string; total: number; wins: number; losses: number; missed: number }>;
  byStrategy: Record<string, { total: number; wins: number; losses: number; missed: number }>;
  bySession: Record<string, { total: number; wins: number; losses: number; missed: number }>;
  rMultiples: { mean: number | null; histogram: Array<{ bin: string; count: number }> };
  sampleSignals: Array<{ symbol: string; strategy: string; direction: string; score: number; candleDatetimeUtc: string; outcome: string; rMultiple: number | null }>;
  proposed?: ReplayResult | null;
  comparison?: { deltaSignals: number; deltaWinRate: number; deltaExpectancyR: number } | null;
}

export default function SimulatorPage() {
  const { toast } = useToast();

  const { data: paramData } = useQuery<{ activeId: number; activeVersion: number; parameters: StrategyParameters[] }>({
    queryKey: ["/api/strategy-parameters"],
  });

  const [paramSetId, setParamSetId] = useState<string>("");
  const [evalWindow, setEvalWindow] = useState(4);
  const [overrideEnabled, setOverrideEnabled] = useState(false);
  const [override, setOverride] = useState<StrategyParamsConfig | null>(null);

  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const ninetyAgo = useMemo(() => new Date(Date.now() - 90 * 86400 * 1000).toISOString().slice(0, 10), []);
  const [startDate, setStartDate] = useState(ninetyAgo);
  const [endDate, setEndDate] = useState(today);

  const selectedSet = paramData?.parameters.find((p) => String(p.id) === paramSetId) ?? paramData?.parameters.find((p) => p.id === paramData.activeId);

  const [result, setResult] = useState<ReplayResult | null>(null);
  const [compareEnabled, setCompareEnabled] = useState(false);
  const [compareParamSetId, setCompareParamSetId] = useState<string>("");

  const saveDraftMutation = useMutation({
    mutationFn: async () => {
      if (!override) throw new Error("No override params to save");
      const all = paramData?.parameters ?? [];
      const nextVersion = all.length === 0 ? 1 : Math.max(...all.map((p) => p.version)) + 1;
      const baseline = selectedSet;
      const res = await apiRequest("POST", "/api/strategy-parameters", {
        version: nextVersion,
        name: `v${nextVersion} (what-if from v${baseline?.version ?? "?"})`,
        description: `Hand-tuned in the simulator from v${baseline?.version ?? "?"} on ${new Date().toISOString().slice(0, 10)}.`,
        params: override,
        activate: false,
      });
      return await res.json();
    },
    onSuccess: (row: any) => {
      toast({ title: "Saved as draft", description: `v${row.version} created. Visit Parameter History to promote it.` });
      queryClient.invalidateQueries({ queryKey: ["/api/strategy-parameters"] });
      queryClient.invalidateQueries({ queryKey: ["/api/strategy-parameters/history"] });
    },
    onError: (err: any) => toast({ title: "Save failed", description: err.message, variant: "destructive" }),
  });

  const runMutation = useMutation({
    mutationFn: async () => {
      const body: any = {
        startDate: new Date(startDate).toISOString(),
        endDate: new Date(endDate).toISOString(),
        evalWindowHours: evalWindow,
        persist: true,
      };
      if (overrideEnabled && override) {
        body.params = override;
      } else if (selectedSet) {
        body.paramSetId = selectedSet.id;
      }
      if (compareEnabled && compareParamSetId) {
        body.compareParamSetId = parseInt(compareParamSetId);
      }
      const res = await apiRequest("POST", "/api/replay", body);
      return (await res.json()) as ReplayResult;
    },
    onSuccess: (data) => {
      setResult(data);
      queryClient.invalidateQueries({ queryKey: ["/api/replay/runs"] });
      toast({ title: "Replay complete", description: `${data.totalSignals} signals in ${(data.durationMs / 1000).toFixed(1)}s` });
    },
    onError: (err: any) => toast({ title: "Replay failed", description: err.message, variant: "destructive" }),
  });

  function startEditOverride() {
    if (!selectedSet) return;
    setOverride(JSON.parse(JSON.stringify(selectedSet.params)));
    setOverrideEnabled(true);
  }

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      <div className="flex items-center gap-2">
        <Beaker className="w-5 h-5" />
        <h1 className="text-2xl font-semibold">What-If Simulator</h1>
      </div>
      <p className="text-sm text-muted-foreground">
        Replay any parameter set against stored historical candles. Outcomes resolve via TP/SL hits within the eval window. No live data is fetched.
      </p>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Replay configuration</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div className="space-y-1">
              <Label>Parameter set</Label>
              <Select value={paramSetId || String(paramData?.activeId ?? "")} onValueChange={setParamSetId}>
                <SelectTrigger data-testid="select-paramset"><SelectValue placeholder="Select" /></SelectTrigger>
                <SelectContent>
                  {paramData?.parameters.map((p) => (
                    <SelectItem key={p.id} value={String(p.id)}>
                      v{p.version} · {p.name} {p.isActive ? "· active" : `· ${p.status}`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Start date</Label>
              <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} data-testid="input-start" />
            </div>
            <div className="space-y-1">
              <Label>End date</Label>
              <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} data-testid="input-end" />
            </div>
            <div className="space-y-1">
              <Label>Eval window (hours)</Label>
              <Input type="number" min={1} max={48} value={evalWindow} onChange={(e) => setEvalWindow(parseInt(e.target.value) || 4)} data-testid="input-window" />
            </div>
          </div>

          <div className="flex items-center gap-3">
            <Switch checked={overrideEnabled} onCheckedChange={(v) => (v ? startEditOverride() : setOverrideEnabled(false))} data-testid="switch-override" />
            <Label>Override params for this run (does not save)</Label>
          </div>

          <div className="space-y-2 p-3 border rounded-md bg-muted/20">
            <div className="flex items-center gap-3">
              <Switch checked={compareEnabled} onCheckedChange={setCompareEnabled} data-testid="switch-compare" />
              <Label>Compare against another parameter set (baseline vs proposed, same window)</Label>
            </div>
            {compareEnabled && (
              <Select value={compareParamSetId} onValueChange={setCompareParamSetId}>
                <SelectTrigger data-testid="select-compare-paramset"><SelectValue placeholder="Select comparison set" /></SelectTrigger>
                <SelectContent>
                  {paramData?.parameters.map((p) => (
                    <SelectItem key={p.id} value={String(p.id)}>v{p.version} · {p.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          {overrideEnabled && override && (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 p-3 border rounded-md bg-muted/30">
              <NumberField label="TC: ADX threshold" value={override.trendContinuation.adxThreshold} onChange={(v) => setOverride({ ...override, trendContinuation: { ...override.trendContinuation, adxThreshold: v } })} />
              <NumberField label="TC: Score threshold" value={override.trendContinuation.scoreThreshold} onChange={(v) => setOverride({ ...override, trendContinuation: { ...override.trendContinuation, scoreThreshold: v } })} />
              <NumberField label="TC: R:R" value={override.trendContinuation.riskRewardRatio} step={0.1} onChange={(v) => setOverride({ ...override, trendContinuation: { ...override.trendContinuation, riskRewardRatio: v } })} />
              <NumberField label="RB: ADX ceiling" value={override.rangeBreakout.adxCeiling} onChange={(v) => setOverride({ ...override, rangeBreakout: { ...override.rangeBreakout, adxCeiling: v } })} />
              <NumberField label="RB: BB width %ile" value={override.rangeBreakout.bbWidthPercentile} onChange={(v) => setOverride({ ...override, rangeBreakout: { ...override.rangeBreakout, bbWidthPercentile: v } })} />
              <NumberField label="RB: R:R" value={override.rangeBreakout.riskRewardRatio} step={0.1} onChange={(v) => setOverride({ ...override, rangeBreakout: { ...override.rangeBreakout, riskRewardRatio: v } })} />
              <div className="flex items-center gap-2 col-span-full">
                <Switch checked={!!override.confluence?.requireHtfAlignment} onCheckedChange={(v) => setOverride({ ...override, confluence: { requireHtfAlignment: v, htfTimeframe: "4h", htfEma200SlopeBars: override.confluence?.htfEma200SlopeBars ?? 4 } })} />
                <Label>Require 4h HTF alignment</Label>
              </div>
              <div className="col-span-full flex justify-end">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => saveDraftMutation.mutate()}
                  disabled={saveDraftMutation.isPending}
                  data-testid="button-save-draft"
                >
                  {saveDraftMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                  Save these params as new draft
                </Button>
              </div>
            </div>
          )}

          <Button onClick={() => runMutation.mutate()} disabled={runMutation.isPending} data-testid="button-run-replay">
            {runMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
            Run replay
          </Button>
        </CardContent>
      </Card>

      {result && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Results {result.proposed ? "— baseline vs proposed" : ""}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {result.proposed && result.comparison && (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 p-3 border rounded-md bg-muted/30">
                <Stat label="Δ Signals" value={fmtDelta(result.comparison.deltaSignals)} testId="stat-delta-signals" />
                <Stat label="Δ Win rate" value={`${fmtDelta(result.comparison.deltaWinRate, 1)}%`} testId="stat-delta-winrate" />
                <Stat label="Δ Expectancy (R)" value={fmtDelta(result.comparison.deltaExpectancyR, 2)} testId="stat-delta-expectancy" />
              </div>
            )}
            <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
              <Stat label="Signals" value={String(result.totalSignals)} testId="stat-total" />
              <Stat label="Wins" value={String(result.wins)} testId="stat-wins" />
              <Stat label="Losses" value={String(result.losses)} testId="stat-losses" />
              <Stat label="Missed" value={String(result.missed)} testId="stat-missed" />
              <Stat label="Win rate" value={result.winRate != null ? `${result.winRate.toFixed(1)}%` : "—"} testId="stat-winrate" />
              <Stat label="Expectancy (R)" value={result.expectancyR != null ? result.expectancyR.toFixed(2) : "—"} testId="stat-expectancy" />
            </div>
            {result.proposed && (
              <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
                <Stat label="(Proposed) Signals" value={String(result.proposed.totalSignals)} testId="stat-prop-total" />
                <Stat label="Wins" value={String(result.proposed.wins)} testId="stat-prop-wins" />
                <Stat label="Losses" value={String(result.proposed.losses)} testId="stat-prop-losses" />
                <Stat label="Missed" value={String(result.proposed.missed)} testId="stat-prop-missed" />
                <Stat label="Win rate" value={result.proposed.winRate != null ? `${result.proposed.winRate.toFixed(1)}%` : "—"} testId="stat-prop-winrate" />
                <Stat label="Expectancy (R)" value={result.proposed.expectancyR != null ? result.proposed.expectancyR.toFixed(2) : "—"} testId="stat-prop-expectancy" />
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <h3 className="text-sm font-medium mb-2">By session (UTC)</h3>
                <Table>
                  <TableHeader>
                    <TableRow><TableHead>Session</TableHead><TableHead>Total</TableHead><TableHead>Wins</TableHead><TableHead>Losses</TableHead><TableHead>Win rate</TableHead></TableRow>
                  </TableHeader>
                  <TableBody>
                    {Object.entries(result.bySession).map(([k, v]) => {
                      const decided = v.wins + v.losses;
                      return (
                        <TableRow key={k} data-testid={`row-session-${k}`}>
                          <TableCell className="capitalize">{k}</TableCell>
                          <TableCell>{v.total}</TableCell>
                          <TableCell>{v.wins}</TableCell>
                          <TableCell>{v.losses}</TableCell>
                          <TableCell>{decided > 0 ? `${((v.wins / decided) * 100).toFixed(1)}%` : "—"}</TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
              <div>
                <h3 className="text-sm font-medium mb-2">R-multiple distribution (mean: {result.rMultiples.mean != null ? result.rMultiples.mean.toFixed(2) : "—"}R)</h3>
                <div className="space-y-1">
                  {result.rMultiples.histogram.length === 0 && <div className="text-xs text-muted-foreground">No decided signals</div>}
                  {result.rMultiples.histogram.map((b) => {
                    const max = Math.max(...result.rMultiples.histogram.map((x) => x.count));
                    return (
                      <div key={b.bin} className="flex items-center gap-2 text-xs" data-testid={`row-rbucket-${b.bin}`}>
                        <span className="w-12 text-right">{b.bin}R</span>
                        <div className="flex-1 h-3 bg-muted rounded">
                          <div className={`h-full rounded ${parseFloat(b.bin) >= 0 ? "bg-primary" : "bg-destructive"}`} style={{ width: `${(b.count / max) * 100}%` }} />
                        </div>
                        <span className="w-8">{b.count}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            <div>
              <h3 className="text-sm font-medium mb-2">By strategy</h3>
              <Table>
                <TableHeader>
                  <TableRow><TableHead>Strategy</TableHead><TableHead>Total</TableHead><TableHead>Wins</TableHead><TableHead>Losses</TableHead><TableHead>Win rate</TableHead></TableRow>
                </TableHeader>
                <TableBody>
                  {Object.entries(result.byStrategy).map(([k, v]) => {
                    const decided = v.wins + v.losses;
                    return (
                      <TableRow key={k} data-testid={`row-strat-${k}`}>
                        <TableCell>{k}</TableCell>
                        <TableCell>{v.total}</TableCell>
                        <TableCell>{v.wins}</TableCell>
                        <TableCell>{v.losses}</TableCell>
                        <TableCell>{decided > 0 ? `${((v.wins / decided) * 100).toFixed(1)}%` : "—"}</TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>

            <div>
              <h3 className="text-sm font-medium mb-2">Sample signals (first {result.sampleSignals.length})</h3>
              <Table>
                <TableHeader>
                  <TableRow><TableHead>Symbol</TableHead><TableHead>Strategy</TableHead><TableHead>Dir</TableHead><TableHead>Score</TableHead><TableHead>Candle</TableHead><TableHead>Outcome</TableHead></TableRow>
                </TableHeader>
                <TableBody>
                  {result.sampleSignals.map((s, i) => (
                    <TableRow key={i} data-testid={`row-sample-${i}`}>
                      <TableCell>{s.symbol}</TableCell>
                      <TableCell>{s.strategy}</TableCell>
                      <TableCell>{s.direction}</TableCell>
                      <TableCell>{s.score}</TableCell>
                      <TableCell className="text-xs">{new Date(s.candleDatetimeUtc).toISOString().slice(0, 16).replace("T", " ")}</TableCell>
                      <TableCell>
                        <Badge variant={s.outcome === "WIN" ? "default" : s.outcome === "LOSS" ? "destructive" : "secondary"}>{s.outcome}</Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function fmtDelta(n: number, decimals: number = 0): string {
  const v = n.toFixed(decimals);
  return n > 0 ? `+${v}` : v;
}

function Stat({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <div className="p-3 border rounded-md">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold" data-testid={testId}>{value}</div>
    </div>
  );
}

function NumberField({ label, value, onChange, step }: { label: string; value: number; onChange: (v: number) => void; step?: number }) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      <Input type="number" value={value} step={step ?? 1} onChange={(e) => onChange(parseFloat(e.target.value))} />
    </div>
  );
}
