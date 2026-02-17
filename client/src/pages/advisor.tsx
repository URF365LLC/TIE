import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Brain, TrendingUp, TrendingDown, Target, BookOpen, Loader2, Sparkles, BarChart3, Search, ChevronDown, ChevronUp, CheckCircle2, Zap, Settings2 } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import ReactMarkdown from "react-markdown";
import type { SignalWithInstrument } from "@shared/schema";

export default function AdvisorPage() {
  const [activeTab, setActiveTab] = useState("portfolio");

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-5xl mx-auto p-4 sm:p-6 space-y-6">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-10 h-10 rounded-md bg-violet-500/10 dark:bg-violet-500/20">
            <Brain className="w-5 h-5 text-violet-500" />
          </div>
          <div>
            <h1 className="text-xl font-semibold" data-testid="text-advisor-title">AI Technical Advisor</h1>
            <p className="text-xs text-muted-foreground">Deep analysis powered by your real trading data</p>
          </div>
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="w-full justify-start gap-1">
            <TabsTrigger value="portfolio" data-testid="tab-portfolio" className="gap-1.5">
              <BarChart3 className="w-3.5 h-3.5" />
              Portfolio Intelligence
            </TabsTrigger>
            <TabsTrigger value="trade" data-testid="tab-trade" className="gap-1.5">
              <Search className="w-3.5 h-3.5" />
              Trade Deep Dive
            </TabsTrigger>
            <TabsTrigger value="strategy" data-testid="tab-strategy" className="gap-1.5">
              <BookOpen className="w-3.5 h-3.5" />
              Strategy Masterclass
            </TabsTrigger>
            <TabsTrigger value="optimizer" data-testid="tab-optimizer" className="gap-1.5">
              <Settings2 className="w-3.5 h-3.5" />
              Strategy Optimizer
            </TabsTrigger>
          </TabsList>

          <TabsContent value="portfolio" className="mt-4">
            <PortfolioTab />
          </TabsContent>

          <TabsContent value="trade" className="mt-4">
            <TradeDeepDiveTab />
          </TabsContent>

          <TabsContent value="strategy" className="mt-4">
            <StrategyMasterclassTab />
          </TabsContent>

          <TabsContent value="optimizer" className="mt-4">
            <StrategyOptimizerTab />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

function PortfolioTab() {
  const [analysis, setAnalysis] = useState<string | null>(null);

  const { data: analyzedData } = useQuery<{ analyzedIds: number[] }>({
    queryKey: ["/api/advisor/analyzed-signals"],
  });
  const analyzedCount = analyzedData?.analyzedIds?.length || 0;

  const mutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/advisor/portfolio-analysis");
      return res.json();
    },
    onSuccess: (data) => setAnalysis(data.analysis),
  });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div>
              <CardTitle className="text-base font-medium">Portfolio Intelligence</CardTitle>
              <CardDescription className="text-xs">
                Your quarterly performance review — cross-strategy, cross-pair, and session analysis to identify where your edge lives
              </CardDescription>
            </div>
            <Button
              onClick={() => mutation.mutate()}
              disabled={mutation.isPending}
              data-testid="button-portfolio-analyze"
            >
              {mutation.isPending ? (
                <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Analyzing...</>
              ) : (
                <><Sparkles className="w-4 h-4 mr-2" /> {analysis ? "Re-analyze" : "Run Analysis"}</>
              )}
            </Button>
          </div>
          {analyzedCount > 0 && (
            <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
              {analyzedCount} deep-dive analyzed trades will strengthen this analysis
            </div>
          )}
        </CardHeader>
        <CardContent>
          {mutation.isPending && (
            <div className="space-y-3">
              <div className="flex items-center gap-3 p-4 rounded-md bg-muted/50">
                <Loader2 className="w-5 h-5 animate-spin text-violet-500" />
                <div>
                  <p className="text-sm font-medium">Building your portfolio intelligence report...</p>
                  <p className="text-xs text-muted-foreground">
                    {analyzedCount > 0
                      ? `Cross-referencing ${analyzedCount} verified deep-dive analyses with all signal data. This may take 20-40 seconds.`
                      : "Analyzing your signals, outcomes, and patterns. This may take 15-30 seconds."}
                  </p>
                </div>
              </div>
              {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-20 w-full" />)}
            </div>
          )}
          {mutation.isError && (
            <div className="p-4 rounded-md bg-red-500/10 text-red-500 text-sm" data-testid="text-portfolio-error">
              Failed to generate analysis. {(mutation.error as Error)?.message || "Please try again."}
            </div>
          )}
          {analysis && !mutation.isPending && (
            <div className="prose prose-sm dark:prose-invert max-w-none" data-testid="text-portfolio-analysis">
              <ReactMarkdown>{analysis}</ReactMarkdown>
            </div>
          )}
          {!analysis && !mutation.isPending && !mutation.isError && (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <BarChart3 className="w-10 h-10 text-muted-foreground mb-3" />
              <p className="text-sm text-muted-foreground mb-1">No analysis generated yet</p>
              <p className="text-xs text-muted-foreground">Click "Run Analysis" for a comprehensive portfolio review across all strategies, pairs, and sessions</p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function TradeDeepDiveTab() {
  const [selectedSignalId, setSelectedSignalId] = useState<number | null>(null);
  const [analysis, setAnalysis] = useState<string | null>(null);
  const [expandedPicker, setExpandedPicker] = useState(true);

  const { data: signals, isLoading: signalsLoading } = useQuery<SignalWithInstrument[]>({
    queryKey: ["/api/backtest/signals", { limit: 100 }],
    queryFn: async () => {
      const res = await fetch("/api/backtest/signals?limit=100");
      return res.json();
    },
  });

  const { data: analyzedData } = useQuery<{ analyzedIds: number[] }>({
    queryKey: ["/api/advisor/analyzed-signals"],
  });
  const analyzedIds = new Set(analyzedData?.analyzedIds || []);

  const mutation = useMutation({
    mutationFn: async (signalId: number) => {
      const res = await apiRequest("POST", "/api/advisor/trade-analysis", { signalId });
      return res.json();
    },
    onSuccess: (data) => {
      setAnalysis(data.analysis);
      setExpandedPicker(false);
      queryClient.invalidateQueries({ queryKey: ["/api/advisor/analyzed-signals"] });
    },
  });

  const unanalyzedSignals = signals?.filter((s) => !analyzedIds.has(s.id)) || [];

  const batchMutation = useMutation({
    mutationFn: async (signalIds: number[]) => {
      const res = await apiRequest("POST", "/api/advisor/batch-analyze", { signalIds });
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/advisor/analyzed-signals"] });
      setAnalysis(`Batch analysis complete: ${data.completed} analyzed successfully, ${data.failed} failed.`);
    },
  });

  const handleAnalyze = (id: number) => {
    setSelectedSignalId(id);
    setAnalysis(null);
    mutation.mutate(id);
  };

  const handleBatchAnalyze = () => {
    const toAnalyze = unanalyzedSignals.slice(0, 20).map((s) => s.id);
    if (toAnalyze.length > 0) {
      setSelectedSignalId(null);
      setAnalysis(null);
      batchMutation.mutate(toAnalyze);
    }
  };

  const handleViewStored = async (id: number) => {
    setSelectedSignalId(id);
    try {
      const res = await fetch(`/api/advisor/trade-analysis/${id}`);
      if (res.ok) {
        const data = await res.json();
        setAnalysis(data.analysis);
        setExpandedPicker(false);
      }
    } catch {}
  };

  const isPending = mutation.isPending || batchMutation.isPending;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div
            className="flex items-center justify-between gap-2 cursor-pointer"
            onClick={() => setExpandedPicker(!expandedPicker)}
          >
            <div>
              <CardTitle className="text-base font-medium">Select a Trade to Analyze</CardTitle>
              <CardDescription className="text-xs">
                Pick any completed signal for a minute-by-minute expert breakdown, or batch analyze multiple
              </CardDescription>
            </div>
            {expandedPicker ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
          </div>
        </CardHeader>
        {expandedPicker && (
          <CardContent>
            {signals && signals.length > 0 && (
              <div className="flex items-center justify-between gap-2 mb-3 pb-3 border-b flex-wrap">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                  <span>{analyzedIds.size} of {signals.length} signals analyzed</span>
                </div>
                {unanalyzedSignals.length > 0 && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={(e) => { e.stopPropagation(); handleBatchAnalyze(); }}
                    disabled={isPending}
                    data-testid="button-batch-analyze"
                  >
                    {batchMutation.isPending ? (
                      <><Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> Batch Analyzing...</>
                    ) : (
                      <><Zap className="w-3.5 h-3.5 mr-1.5" /> Analyze {Math.min(unanalyzedSignals.length, 20)} Unanalyzed</>
                    )}
                  </Button>
                )}
              </div>
            )}
            {signalsLoading ? (
              <div className="space-y-2">
                {[1, 2, 3].map((i) => <Skeleton key={i} className="h-12 w-full" />)}
              </div>
            ) : !signals?.length ? (
              <div className="flex flex-col items-center justify-center py-8 text-center">
                <Target className="w-8 h-8 text-muted-foreground mb-2" />
                <p className="text-sm text-muted-foreground">No completed signals available for analysis</p>
                <p className="text-xs text-muted-foreground mt-1">Signals need to resolve (win/loss/missed) before deep dive analysis</p>
              </div>
            ) : (
              <div className="space-y-1 max-h-80 overflow-y-auto">
                {signals.map((sig) => {
                  const reason = (sig.reasonJson ?? {}) as Record<string, any>;
                  const isSelected = selectedSignalId === sig.id;
                  const isAnalyzed = analyzedIds.has(sig.id);
                  return (
                    <div
                      key={sig.id}
                      className={`flex items-center justify-between p-3 rounded-md cursor-pointer border ${isSelected ? "border-violet-500 bg-violet-500/5" : "border-transparent hover-elevate"}`}
                      onClick={() => isAnalyzed ? handleViewStored(sig.id) : handleAnalyze(sig.id)}
                      data-testid={`signal-pick-${sig.id}`}
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div className={`flex items-center justify-center w-8 h-8 rounded-md shrink-0 ${sig.direction === "LONG" ? "bg-emerald-500/10 text-emerald-500 dark:bg-emerald-500/20" : "bg-red-500/10 text-red-500 dark:bg-red-500/20"}`}>
                          {sig.direction === "LONG" ? <TrendingUp className="w-3.5 h-3.5" /> : <TrendingDown className="w-3.5 h-3.5" />}
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-sm font-semibold">{sig.instrument.canonicalSymbol}</span>
                            <Badge variant="secondary" className="text-[10px]">{sig.strategy.replace(/_/g, " ")}</Badge>
                            <OutcomeBadge outcome={sig.outcome || "\u2014"} />
                            {isAnalyzed && (
                              <span className="inline-flex items-center gap-0.5 text-[10px] text-emerald-500">
                                <CheckCircle2 className="w-3 h-3" /> Analyzed
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-2 mt-0.5 text-xs text-muted-foreground flex-wrap">
                            <span>{sig.timeframe}</span>
                            <span>{new Date(sig.detectedAt).toLocaleString()}</span>
                            {reason.entryPrice && <span>Entry: {formatPrice(reason.entryPrice)}</span>}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <ScoreBadge score={sig.score} />
                        {isSelected && mutation.isPending && <Loader2 className="w-4 h-4 animate-spin text-violet-500" />}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        )}
      </Card>

      {batchMutation.isPending && (
        <Card>
          <CardContent className="p-6">
            <div className="flex items-center gap-3 p-4 rounded-md bg-muted/50 mb-4">
              <Loader2 className="w-5 h-5 animate-spin text-violet-500" />
              <div>
                <p className="text-sm font-medium">Batch analyzing trades...</p>
                <p className="text-xs text-muted-foreground">Processing up to {Math.min(unanalyzedSignals.length, 20)} signals sequentially. Each signal fetches 1-minute candles and runs AI analysis. This may take several minutes.</p>
              </div>
            </div>
            {[1, 2, 3].map((i) => <Skeleton key={i} className="h-16 w-full mb-3" />)}
          </CardContent>
        </Card>
      )}

      {mutation.isPending && (
        <Card>
          <CardContent className="p-6">
            <div className="flex items-center gap-3 p-4 rounded-md bg-muted/50 mb-4">
              <Loader2 className="w-5 h-5 animate-spin text-violet-500" />
              <div>
                <p className="text-sm font-medium">Performing deep trade analysis...</p>
                <p className="text-xs text-muted-foreground">Fetching 1-minute candles, analyzing price action, market psychology, and order flow. This may take 20-40 seconds.</p>
              </div>
            </div>
            {[1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-16 w-full mb-3" />)}
          </CardContent>
        </Card>
      )}

      {(mutation.isError || batchMutation.isError) && (
        <Card>
          <CardContent className="p-6">
            <div className="p-4 rounded-md bg-red-500/10 text-red-500 text-sm" data-testid="text-trade-error">
              Failed to generate trade analysis. {((mutation.error || batchMutation.error) as Error)?.message || "Please try again."}
            </div>
          </CardContent>
        </Card>
      )}

      {analysis && !isPending && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base font-medium flex items-center gap-2">
              <Brain className="w-4 h-4 text-violet-500" />
              Deep Trade Analysis
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="prose prose-sm dark:prose-invert max-w-none" data-testid="text-trade-analysis">
              <ReactMarkdown>{analysis}</ReactMarkdown>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function StrategyMasterclassTab() {
  const [selectedStrategy, setSelectedStrategy] = useState<string>("TREND_CONTINUATION");
  const [analysis, setAnalysis] = useState<string | null>(null);

  const { data: analyzedData } = useQuery<{ analyzedIds: number[] }>({
    queryKey: ["/api/advisor/analyzed-signals"],
  });
  const analyzedCount = analyzedData?.analyzedIds?.length || 0;

  const mutation = useMutation({
    mutationFn: async (strategy: string) => {
      const res = await apiRequest("POST", "/api/advisor/strategy-guide", { strategy });
      return res.json();
    },
    onSuccess: (data) => setAnalysis(data.analysis),
  });

  const handleGenerate = () => {
    setAnalysis(null);
    mutation.mutate(selectedStrategy);
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div>
              <CardTitle className="text-base font-medium">Strategy Masterclass</CardTitle>
              <CardDescription className="text-xs">
                {analyzedCount > 0
                  ? `Grounded in ${analyzedCount} deep-dive analyzed trades with verified 1-minute price action data`
                  : "Run Trade Deep Dive on signals first for fact-checked insights (currently using raw signal data only)"}
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Select value={selectedStrategy} onValueChange={setSelectedStrategy}>
                <SelectTrigger className="w-[220px]" data-testid="select-strategy">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="TREND_CONTINUATION">Trend Continuation</SelectItem>
                  <SelectItem value="RANGE_BREAKOUT">Range Breakout</SelectItem>
                </SelectContent>
              </Select>
              <Button
                onClick={handleGenerate}
                disabled={mutation.isPending}
                data-testid="button-strategy-analyze"
              >
                {mutation.isPending ? (
                  <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Generating...</>
                ) : (
                  <><BookOpen className="w-4 h-4 mr-2" /> {analysis ? "Regenerate" : "Generate Guide"}</>
                )}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {mutation.isPending && (
            <div className="space-y-3">
              <div className="flex items-center gap-3 p-4 rounded-md bg-muted/50">
                <Loader2 className="w-5 h-5 animate-spin text-violet-500" />
                <div>
                  <p className="text-sm font-medium">Generating strategy masterclass...</p>
                  <p className="text-xs text-muted-foreground">
                    {analyzedCount > 0
                      ? `Building guide from ${analyzedCount} fact-checked trade analyses. This may take 20-40 seconds.`
                      : "Analyzing raw signal data. For better results, run Trade Deep Dive first."}
                  </p>
                </div>
              </div>
              {[1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-16 w-full" />)}
            </div>
          )}
          {mutation.isError && (
            <div className="p-4 rounded-md bg-red-500/10 text-red-500 text-sm" data-testid="text-strategy-error">
              Failed to generate strategy guide. {(mutation.error as Error)?.message || "Please try again."}
            </div>
          )}
          {analysis && !mutation.isPending && (
            <div className="prose prose-sm dark:prose-invert max-w-none" data-testid="text-strategy-analysis">
              <ReactMarkdown>{analysis}</ReactMarkdown>
            </div>
          )}
          {!analysis && !mutation.isPending && !mutation.isError && (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <BookOpen className="w-10 h-10 text-muted-foreground mb-3" />
              <p className="text-sm text-muted-foreground mb-1">No guide generated yet</p>
              <p className="text-xs text-muted-foreground">Select a strategy and click "Generate Guide" for a complete masterclass based on your real data</p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function StrategyOptimizerTab() {
  const [analysis, setAnalysis] = useState<string | null>(null);

  const { data: analyzedData } = useQuery<{ analyzedIds: number[] }>({
    queryKey: ["/api/advisor/analyzed-signals"],
  });
  const analyzedCount = analyzedData?.analyzedIds?.length || 0;

  const mutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/advisor/strategy-optimizer");
      return res.json();
    },
    onSuccess: (data) => setAnalysis(data.analysis),
  });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div>
              <CardTitle className="text-base font-medium">Strategy Optimizer</CardTitle>
              <CardDescription className="text-xs">
                Synthesizes all intelligence layers: Trade Deep Dives + Portfolio patterns + Strategy profiles into concrete action items. Advisory only.
              </CardDescription>
            </div>
            <Button
              onClick={() => mutation.mutate()}
              disabled={mutation.isPending || analyzedCount < 3}
              data-testid="button-optimizer-analyze"
            >
              {mutation.isPending ? (
                <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Generating...</>
              ) : (
                <><Settings2 className="w-4 h-4 mr-2" /> {analysis ? "Regenerate" : "Generate Recommendations"}</>
              )}
            </Button>
          </div>
          {analyzedCount < 3 && (
            <div className="mt-2 p-3 rounded-md bg-amber-500/10 text-amber-600 dark:text-amber-400 text-xs">
              Requires at least 3 deep-dive analyzed trades. Currently {analyzedCount} analyzed. Go to Trade Deep Dive tab to analyze more signals first.
            </div>
          )}
          {analyzedCount >= 3 && (
            <div className="mt-2 space-y-1.5">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                {analyzedCount} deep-dive analyses feeding this optimizer
              </div>
              <div className="flex items-center gap-3 text-[10px] text-muted-foreground flex-wrap">
                <span className="flex items-center gap-1"><Search className="w-3 h-3" /> Trade Deep Dive</span>
                <span className="text-muted-foreground/50">+</span>
                <span className="flex items-center gap-1"><BarChart3 className="w-3 h-3" /> Portfolio Intelligence</span>
                <span className="text-muted-foreground/50">+</span>
                <span className="flex items-center gap-1"><BookOpen className="w-3 h-3" /> Strategy Profiles</span>
                <span className="text-muted-foreground/50">=</span>
                <span className="flex items-center gap-1 font-medium"><Settings2 className="w-3 h-3" /> Optimizer</span>
              </div>
            </div>
          )}
        </CardHeader>
        <CardContent>
          {mutation.isPending && (
            <div className="space-y-3">
              <div className="flex items-center gap-3 p-4 rounded-md bg-muted/50">
                <Loader2 className="w-5 h-5 animate-spin text-violet-500" />
                <div>
                  <p className="text-sm font-medium">Synthesizing all intelligence layers...</p>
                  <p className="text-xs text-muted-foreground">Gathering {analyzedCount} deep-dive analyses, cross-pair/session patterns, and per-strategy profiles. Building comprehensive recommendations. This may take 30-60 seconds.</p>
                </div>
              </div>
              {[1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-16 w-full" />)}
            </div>
          )}
          {mutation.isError && (
            <div className="p-4 rounded-md bg-red-500/10 text-red-500 text-sm" data-testid="text-optimizer-error">
              Failed to generate recommendations. {(mutation.error as Error)?.message || "Please try again."}
            </div>
          )}
          {analysis && !mutation.isPending && (
            <div>
              <div className="mb-4 p-3 rounded-md bg-amber-500/10 text-amber-600 dark:text-amber-400 text-xs flex items-center gap-2">
                <Settings2 className="w-4 h-4 shrink-0" />
                These are recommendations only. No changes have been applied to your strategies. Review each suggestion and discuss with your developer before implementing.
              </div>
              <div className="prose prose-sm dark:prose-invert max-w-none" data-testid="text-optimizer-analysis">
                <ReactMarkdown>{analysis}</ReactMarkdown>
              </div>
            </div>
          )}
          {!analysis && !mutation.isPending && !mutation.isError && analyzedCount >= 3 && (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <Settings2 className="w-10 h-10 text-muted-foreground mb-3" />
              <p className="text-sm text-muted-foreground mb-1">No recommendations generated yet</p>
              <p className="text-xs text-muted-foreground">Click "Generate Recommendations" for data-driven strategy improvements</p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function OutcomeBadge({ outcome }: { outcome: string }) {
  const map: Record<string, string> = {
    WIN: "bg-emerald-500/10 text-emerald-500 dark:bg-emerald-500/20",
    LOSS: "bg-red-500/10 text-red-500 dark:bg-red-500/20",
    MISSED: "bg-muted text-muted-foreground",
  };
  return (
    <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-[10px] font-medium ${map[outcome] || map.MISSED}`}>
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

function formatPrice(value: number | string | undefined): string {
  if (value == null) return "\u2014";
  const num = typeof value === "string" ? parseFloat(value) : value;
  if (isNaN(num)) return "\u2014";
  if (Math.abs(num) >= 100) return num.toFixed(2);
  if (Math.abs(num) >= 1) return num.toFixed(4);
  return num.toFixed(6);
}
