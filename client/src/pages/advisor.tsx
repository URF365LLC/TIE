import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Brain, TrendingUp, TrendingDown, Target, BookOpen, Loader2, Sparkles, BarChart3, Search, ChevronDown, ChevronUp } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
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
          <TabsList className="w-full justify-start">
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
        </Tabs>
      </div>
    </div>
  );
}

function PortfolioTab() {
  const [analysis, setAnalysis] = useState<string | null>(null);

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
                Analyzes all your completed signals to find patterns, win correlations, score thresholds, and actionable insights
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
        </CardHeader>
        <CardContent>
          {mutation.isPending && (
            <div className="space-y-3">
              <div className="flex items-center gap-3 p-4 rounded-md bg-muted/50">
                <Loader2 className="w-5 h-5 animate-spin text-violet-500" />
                <div>
                  <p className="text-sm font-medium">Analyzing your trading data...</p>
                  <p className="text-xs text-muted-foreground">The AI is studying your signals, outcomes, and patterns. This may take 15-30 seconds.</p>
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
              <p className="text-xs text-muted-foreground">Click "Run Analysis" to have the AI study your backtest data and find winning patterns</p>
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
    queryKey: ["/api/backtest/signals", "?limit=100"],
  });

  const mutation = useMutation({
    mutationFn: async (signalId: number) => {
      const res = await apiRequest("POST", "/api/advisor/trade-analysis", { signalId });
      return res.json();
    },
    onSuccess: (data) => {
      setAnalysis(data.analysis);
      setExpandedPicker(false);
    },
  });

  const handleAnalyze = (id: number) => {
    setSelectedSignalId(id);
    setAnalysis(null);
    mutation.mutate(id);
  };

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
                Pick any completed signal for a minute-by-minute expert breakdown
              </CardDescription>
            </div>
            {expandedPicker ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
          </div>
        </CardHeader>
        {expandedPicker && (
          <CardContent>
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
              <div className="space-y-1 max-h-72 overflow-y-auto">
                {signals.map((sig) => {
                  const reason = (sig.reasonJson ?? {}) as Record<string, any>;
                  const isSelected = selectedSignalId === sig.id;
                  return (
                    <div
                      key={sig.id}
                      className={`flex items-center justify-between p-3 rounded-md cursor-pointer border ${isSelected ? "border-violet-500 bg-violet-500/5" : "border-transparent hover-elevate"}`}
                      onClick={() => handleAnalyze(sig.id)}
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
                            <OutcomeBadge outcome={sig.outcome || "—"} />
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

      {mutation.isError && (
        <Card>
          <CardContent className="p-6">
            <div className="p-4 rounded-md bg-red-500/10 text-red-500 text-sm" data-testid="text-trade-error">
              Failed to generate trade analysis. {(mutation.error as Error)?.message || "Please try again."}
            </div>
          </CardContent>
        </Card>
      )}

      {analysis && !mutation.isPending && (
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
                In-depth breakdown of each strategy's performance, winning formula, failure patterns, and chart identification guide
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
                  <p className="text-xs text-muted-foreground">The AI is analyzing winning vs losing conditions, building your visual checklist, and creating improvement recommendations. This may take 20-40 seconds.</p>
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
