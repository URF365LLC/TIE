import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Download, BarChart3, Layers, ArrowUpDown, Globe, Clock, Calendar, ArrowUp, ArrowDown, type LucideIcon } from "lucide-react";

type GroupBy = "pair" | "strategy" | "direction" | "asset" | "session" | "hour";

interface AggregateRow {
  key: string;
  total: number;
  wins: number;
  losses: number;
  missed: number;
}

const TABS: { value: GroupBy; label: string; icon: LucideIcon }[] = [
  { value: "pair", label: "By Pair", icon: BarChart3 },
  { value: "strategy", label: "By Strategy", icon: Layers },
  { value: "direction", label: "By Direction", icon: ArrowUpDown },
  { value: "asset", label: "By Asset Class", icon: Globe },
  { value: "session", label: "By Session", icon: Calendar },
  { value: "hour", label: "By Hour (UTC)", icon: Clock },
];

export default function PerformancePage() {
  const [groupBy, setGroupBy] = useState<GroupBy>("pair");

  return (
    <div className="flex flex-col gap-6 p-6 max-w-7xl mx-auto">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight" data-testid="text-performance-title">Performance Analytics</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Win/loss breakdowns across signal dimensions. Win rate excludes MISSED signals.
        </p>
      </div>

      <Tabs value={groupBy} onValueChange={(v) => setGroupBy(v as GroupBy)}>
        <TabsList className="flex-wrap h-auto">
          {TABS.map((t) => (
            <TabsTrigger key={t.value} value={t.value} data-testid={`tab-perf-${t.value}`} className="gap-1.5">
              <t.icon className="w-3.5 h-3.5" /> {t.label}
            </TabsTrigger>
          ))}
        </TabsList>

        {TABS.map((t) => (
          <TabsContent key={t.value} value={t.value} className="mt-4">
            <PerformanceTable groupBy={t.value} label={t.label} />
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}

type SortKey = "key" | "total" | "wins" | "losses" | "missed" | "resolved" | "winRate";

function PerformanceTable({ groupBy, label }: { groupBy: GroupBy; label: string }) {
  const { data, isLoading } = useQuery<{ groupBy: GroupBy; rows: AggregateRow[] }>({
    queryKey: ["/api/analytics/performance", `?groupBy=${groupBy}`],
  });

  const [sortKey, setSortKey] = useState<SortKey>("total");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const baseRows = data?.rows ?? [];
  const rows = [...baseRows].sort((a, b) => {
    const ar = a.wins + a.losses;
    const br = b.wins + b.losses;
    const aw = ar > 0 ? a.wins / ar : -1;
    const bw = br > 0 ? b.wins / br : -1;
    let cmp = 0;
    switch (sortKey) {
      case "key": cmp = a.key.localeCompare(b.key); break;
      case "total": cmp = a.total - b.total; break;
      case "wins": cmp = a.wins - b.wins; break;
      case "losses": cmp = a.losses - b.losses; break;
      case "missed": cmp = a.missed - b.missed; break;
      case "resolved": cmp = ar - br; break;
      case "winRate": cmp = aw - bw; break;
    }
    return sortDir === "asc" ? cmp : -cmp;
  });

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortDir(key === "key" ? "asc" : "desc");
    }
  };

  const SortIcon = ({ k }: { k: SortKey }) => {
    if (sortKey !== k) return <ArrowUpDown className="w-3 h-3 inline ml-1 opacity-40" />;
    return sortDir === "asc"
      ? <ArrowUp className="w-3 h-3 inline ml-1" />
      : <ArrowDown className="w-3 h-3 inline ml-1" />;
  };

  const exportCsv = () => {
    const header = ["key", "total", "wins", "losses", "missed", "resolved", "win_rate_pct"];
    const lines = rows.map((r) => {
      const resolved = r.wins + r.losses;
      const wr = resolved > 0 ? ((r.wins / resolved) * 100).toFixed(2) : "";
      return [r.key, r.total, r.wins, r.losses, r.missed, resolved, wr].join(",");
    });
    const csv = [header.join(","), ...lines].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `performance_${groupBy}_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Card>
      <CardHeader className="pb-3 flex flex-row items-center justify-between space-y-0 gap-2">
        <CardTitle className="text-base font-medium">{label}</CardTitle>
        <Button
          size="sm"
          variant="outline"
          onClick={exportCsv}
          disabled={!rows.length}
          data-testid={`button-export-${groupBy}`}
        >
          <Download className="w-3.5 h-3.5 mr-1.5" /> Export CSV
        </Button>
      </CardHeader>
      <CardContent className="p-0">
        {isLoading ? (
          <div className="p-4 space-y-2">
            {[1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-10 w-full" />)}
          </div>
        ) : !rows.length ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <BarChart3 className="w-10 h-10 text-muted-foreground mb-3" />
            <p className="text-sm text-muted-foreground">No data yet</p>
            <p className="text-xs text-muted-foreground mt-1">Resolved signals will appear here once the scanner produces outcomes</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/30 text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="text-left px-4 py-2.5 font-medium cursor-pointer select-none hover:text-foreground" onClick={() => toggleSort("key")} data-testid={`sort-key-${groupBy}`}>{label.replace(/^By /, "")}<SortIcon k="key" /></th>
                  <th className="text-right px-4 py-2.5 font-medium cursor-pointer select-none hover:text-foreground" onClick={() => toggleSort("total")} data-testid={`sort-total-${groupBy}`}>Total<SortIcon k="total" /></th>
                  <th className="text-right px-4 py-2.5 font-medium cursor-pointer select-none hover:text-foreground" onClick={() => toggleSort("wins")} data-testid={`sort-wins-${groupBy}`}>Wins<SortIcon k="wins" /></th>
                  <th className="text-right px-4 py-2.5 font-medium cursor-pointer select-none hover:text-foreground" onClick={() => toggleSort("losses")} data-testid={`sort-losses-${groupBy}`}>Losses<SortIcon k="losses" /></th>
                  <th className="text-right px-4 py-2.5 font-medium cursor-pointer select-none hover:text-foreground" onClick={() => toggleSort("missed")} data-testid={`sort-missed-${groupBy}`}>Missed<SortIcon k="missed" /></th>
                  <th className="text-right px-4 py-2.5 font-medium cursor-pointer select-none hover:text-foreground" onClick={() => toggleSort("resolved")} data-testid={`sort-resolved-${groupBy}`}>Resolved<SortIcon k="resolved" /></th>
                  <th className="text-right px-4 py-2.5 font-medium cursor-pointer select-none hover:text-foreground" onClick={() => toggleSort("winRate")} data-testid={`sort-winrate-${groupBy}`}>Win Rate<SortIcon k="winRate" /></th>
                  <th className="text-left px-4 py-2.5 font-medium w-32">Bar</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {rows.map((r) => {
                  const resolved = r.wins + r.losses;
                  const wr = resolved > 0 ? (r.wins / resolved) * 100 : 0;
                  const wrLabel = resolved > 0 ? `${wr.toFixed(1)}%` : "—";
                  const color = wr >= 60 ? "bg-emerald-500" : wr >= 40 ? "bg-amber-500" : "bg-red-500";
                  return (
                    <tr key={r.key} data-testid={`row-perf-${r.key}`} className="hover:bg-muted/20">
                      <td className="px-4 py-2.5 font-medium">{r.key}</td>
                      <td className="px-4 py-2.5 text-right text-muted-foreground">{r.total}</td>
                      <td className="px-4 py-2.5 text-right text-emerald-500">{r.wins}</td>
                      <td className="px-4 py-2.5 text-right text-red-500">{r.losses}</td>
                      <td className="px-4 py-2.5 text-right text-muted-foreground">{r.missed}</td>
                      <td className="px-4 py-2.5 text-right">{resolved}</td>
                      <td className="px-4 py-2.5 text-right font-semibold">{wrLabel}</td>
                      <td className="px-4 py-2.5">
                        <div className="h-2 rounded-full bg-muted overflow-hidden">
                          {resolved > 0 && (
                            <div className={`h-full rounded-full ${color}`} style={{ width: `${Math.min(100, wr)}%` }} />
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
