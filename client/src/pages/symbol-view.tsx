import { useQuery } from "@tanstack/react-query";
import { useParams } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { TrendingUp, TrendingDown, ArrowLeft, CandlestickChart, Activity } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Link } from "wouter";
import type { Candle, Indicator, SignalWithInstrument, Instrument } from "@shared/schema";
import { useRef, useEffect } from "react";

export default function SymbolView() {
  const params = useParams<{ symbol: string }>();
  const symbol = params.symbol;

  const { data: instrument, isLoading: instLoading } = useQuery<Instrument>({
    queryKey: ["/api/instruments", symbol],
  });

  const { data: candles, isLoading: candlesLoading } = useQuery<Candle[]>({
    queryKey: ["/api/candles", `?symbol=${symbol}&tf=15m`],
    enabled: !!symbol,
  });

  const { data: indicators } = useQuery<Indicator[]>({
    queryKey: ["/api/indicators", `?symbol=${symbol}&tf=15m`],
    enabled: !!symbol,
  });

  const { data: signals } = useQuery<SignalWithInstrument[]>({
    queryKey: ["/api/signals", `?symbol=${symbol}`],
    enabled: !!symbol,
  });

  return (
    <div className="flex flex-col gap-6 p-6 max-w-7xl mx-auto">
      <div className="flex items-center gap-3 flex-wrap">
        <Link href="/instruments">
          <Button variant="ghost" size="icon" data-testid="button-back">
            <ArrowLeft className="w-4 h-4" />
          </Button>
        </Link>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight" data-testid="text-symbol-title">
            {symbol}
          </h1>
          {!instLoading && instrument && (
            <div className="flex items-center gap-2 mt-0.5">
              <Badge variant="secondary" className="text-[10px]">{instrument.assetClass}</Badge>
              <span className="text-xs text-muted-foreground">{instrument.vendorSymbol}</span>
            </div>
          )}
        </div>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center gap-2">
            <CandlestickChart className="w-4 h-4 text-muted-foreground" />
            <CardTitle className="text-base font-medium">Price Chart (15m)</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          {candlesLoading ? (
            <Skeleton className="h-[400px] w-full" />
          ) : !candles?.length ? (
            <div className="flex flex-col items-center justify-center h-[400px] text-center">
              <CandlestickChart className="w-10 h-10 text-muted-foreground mb-3" />
              <p className="text-sm text-muted-foreground">No candle data available</p>
              <p className="text-xs text-muted-foreground mt-1">Run a scan to fetch market data</p>
            </div>
          ) : (
            <CandleChart candles={candles} indicators={indicators} />
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center gap-2">
              <Activity className="w-4 h-4 text-muted-foreground" />
              <CardTitle className="text-base font-medium">Latest Indicators</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            {!indicators?.length ? (
              <p className="text-sm text-muted-foreground py-4 text-center">No indicator data</p>
            ) : (
              <IndicatorGrid indicator={indicators[indicators.length - 1]} />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base font-medium">Signals for {symbol}</CardTitle>
          </CardHeader>
          <CardContent>
            {!signals?.length ? (
              <p className="text-sm text-muted-foreground py-4 text-center">No signals detected</p>
            ) : (
              <div className="space-y-2">
                {signals.slice(0, 10).map((sig) => (
                  <div key={sig.id} className="flex items-center justify-between p-3 rounded-md border border-card-border" data-testid={`signal-detail-${sig.id}`}>
                    <div className="flex items-center gap-2">
                      {sig.direction === "LONG" ? (
                        <TrendingUp className="w-4 h-4 text-emerald-500" />
                      ) : (
                        <TrendingDown className="w-4 h-4 text-red-500" />
                      )}
                      <div>
                        <span className="text-sm font-medium">{sig.direction}</span>
                        <p className="text-xs text-muted-foreground">{sig.strategy.replace("_", " ")}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <ScoreBadge score={sig.score} />
                      <Badge variant="secondary" className="text-[10px]">{sig.status}</Badge>
                    </div>
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

function CandleChart({ candles, indicators }: { candles: Candle[]; indicators?: Indicator[] }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current || !candles.length) return;

    let chart: any;
    let resizeObserver: ResizeObserver;

    const initChart = async () => {
      const { createChart, CandlestickSeries, LineSeries } = await import("lightweight-charts");

      const isDark = document.documentElement.classList.contains("dark");

      chart = createChart(containerRef.current!, {
        width: containerRef.current!.clientWidth,
        height: 400,
        layout: {
          background: { color: "transparent" },
          textColor: isDark ? "#9ca3af" : "#6b7280",
          fontSize: 11,
        },
        grid: {
          vertLines: { color: isDark ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.04)" },
          horzLines: { color: isDark ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.04)" },
        },
        crosshair: { mode: 0 },
        timeScale: { borderColor: isDark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.1)", timeVisible: true },
        rightPriceScale: { borderColor: isDark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.1)" },
      });

      const candleSeries = chart.addSeries(CandlestickSeries, {
        upColor: "#22c55e",
        downColor: "#ef4444",
        borderDownColor: "#ef4444",
        borderUpColor: "#22c55e",
        wickDownColor: "#ef4444",
        wickUpColor: "#22c55e",
      });

      const sorted = [...candles].sort(
        (a, b) => new Date(a.datetimeUtc).getTime() - new Date(b.datetimeUtc).getTime()
      );

      candleSeries.setData(
        sorted.map((c) => ({
          time: Math.floor(new Date(c.datetimeUtc).getTime() / 1000) as any,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
        }))
      );

      if (indicators?.length) {
        const sortedInd = [...indicators].sort(
          (a, b) => new Date(a.datetimeUtc).getTime() - new Date(b.datetimeUtc).getTime()
        );

        const emaConfigs = [
          { key: "ema9" as const, color: "#f59e0b", label: "EMA 9" },
          { key: "ema21" as const, color: "#3b82f6", label: "EMA 21" },
          { key: "ema55" as const, color: "#8b5cf6", label: "EMA 55" },
          { key: "ema200" as const, color: "#ec4899", label: "EMA 200" },
        ];

        for (const ema of emaConfigs) {
          const lineData = sortedInd
            .filter((ind) => ind[ema.key] != null)
            .map((ind) => ({
              time: Math.floor(new Date(ind.datetimeUtc).getTime() / 1000) as any,
              value: ind[ema.key]!,
            }));

          if (lineData.length > 0) {
            const series = chart.addSeries(LineSeries, {
              color: ema.color,
              lineWidth: 1,
              priceLineVisible: false,
              lastValueVisible: false,
            });
            series.setData(lineData);
          }
        }

        const bbUpperData = sortedInd.filter((ind) => ind.bbUpper != null).map((ind) => ({
          time: Math.floor(new Date(ind.datetimeUtc).getTime() / 1000) as any,
          value: ind.bbUpper!,
        }));
        const bbLowerData = sortedInd.filter((ind) => ind.bbLower != null).map((ind) => ({
          time: Math.floor(new Date(ind.datetimeUtc).getTime() / 1000) as any,
          value: ind.bbLower!,
        }));

        if (bbUpperData.length > 0) {
          const bbUp = chart.addSeries(LineSeries, {
            color: "rgba(100,149,237,0.3)",
            lineWidth: 1,
            lineStyle: 2,
            priceLineVisible: false,
            lastValueVisible: false,
          });
          bbUp.setData(bbUpperData);
        }
        if (bbLowerData.length > 0) {
          const bbLow = chart.addSeries(LineSeries, {
            color: "rgba(100,149,237,0.3)",
            lineWidth: 1,
            lineStyle: 2,
            priceLineVisible: false,
            lastValueVisible: false,
          });
          bbLow.setData(bbLowerData);
        }
      }

      chart.timeScale().fitContent();

      resizeObserver = new ResizeObserver(() => {
        if (containerRef.current) {
          chart.applyOptions({ width: containerRef.current.clientWidth });
        }
      });
      resizeObserver.observe(containerRef.current!);
    };

    initChart();

    return () => {
      if (resizeObserver && containerRef.current) {
        resizeObserver.unobserve(containerRef.current);
      }
      if (chart) {
        chart.remove();
      }
    };
  }, [candles, indicators]);

  return <div ref={containerRef} className="w-full" data-testid="chart-container" />;
}

function IndicatorGrid({ indicator }: { indicator: Indicator }) {
  const items = [
    { label: "EMA 9", value: indicator.ema9?.toFixed(5) },
    { label: "EMA 21", value: indicator.ema21?.toFixed(5) },
    { label: "EMA 55", value: indicator.ema55?.toFixed(5) },
    { label: "EMA 200", value: indicator.ema200?.toFixed(5) },
    { label: "BB Upper", value: indicator.bbUpper?.toFixed(5) },
    { label: "BB Lower", value: indicator.bbLower?.toFixed(5) },
    { label: "BB Width", value: indicator.bbWidth?.toFixed(5) },
    { label: "MACD", value: indicator.macd?.toFixed(5) },
    { label: "MACD Signal", value: indicator.macdSignal?.toFixed(5) },
    { label: "MACD Hist", value: indicator.macdHist?.toFixed(5) },
    { label: "ATR", value: indicator.atr?.toFixed(5) },
    { label: "ADX", value: indicator.adx?.toFixed(2) },
  ];

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
      {items.map((item) => (
        <div key={item.label} className="p-2 rounded-md border border-card-border">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wider">{item.label}</p>
          <p className="text-sm font-mono font-medium mt-0.5">{item.value ?? "—"}</p>
        </div>
      ))}
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
