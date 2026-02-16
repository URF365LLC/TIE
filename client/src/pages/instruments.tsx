import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Eye, Database, CheckCircle, XCircle } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Link } from "wouter";
import type { Instrument } from "@shared/schema";

export default function InstrumentsPage() {
  const { toast } = useToast();

  const { data: instruments, isLoading } = useQuery<Instrument[]>({
    queryKey: ["/api/instruments"],
  });

  const seedMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/instruments/seed");
      return res.json();
    },
    onSuccess: (data: { count: number }) => {
      toast({ title: "Instruments seeded", description: `${data.count} instruments created.` });
      queryClient.invalidateQueries({ queryKey: ["/api/instruments"] });
    },
    onError: (err: Error) => {
      toast({ title: "Seed failed", description: err.message, variant: "destructive" });
    },
  });

  const grouped = {
    FOREX: instruments?.filter((i) => i.assetClass === "FOREX") ?? [],
    METAL: instruments?.filter((i) => i.assetClass === "METAL") ?? [],
    CRYPTO: instruments?.filter((i) => i.assetClass === "CRYPTO") ?? [],
  };

  return (
    <div className="flex flex-col gap-6 p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight" data-testid="text-instruments-title">Instruments</h1>
          <p className="text-sm text-muted-foreground mt-1">Managed whitelist of tradeable instruments</p>
        </div>
        {(!instruments || instruments.length === 0) && (
          <Button
            onClick={() => seedMutation.mutate()}
            disabled={seedMutation.isPending}
            data-testid="button-seed-instruments"
          >
            <Database className="w-4 h-4 mr-2" />
            {seedMutation.isPending ? "Seeding..." : "Seed Instruments"}
          </Button>
        )}
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1, 2, 3, 4, 5, 6].map((i) => <Skeleton key={i} className="h-20" />)}
        </div>
      ) : !instruments?.length ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <Eye className="w-10 h-10 text-muted-foreground mb-3" />
            <p className="text-sm text-muted-foreground">No instruments found</p>
            <p className="text-xs text-muted-foreground mt-1">Click "Seed Instruments" to populate the whitelist</p>
          </CardContent>
        </Card>
      ) : (
        <Tabs defaultValue="FOREX">
          <TabsList data-testid="tabs-asset-class">
            <TabsTrigger value="FOREX">Forex ({grouped.FOREX.length})</TabsTrigger>
            <TabsTrigger value="METAL">Metals ({grouped.METAL.length})</TabsTrigger>
            <TabsTrigger value="CRYPTO">Crypto ({grouped.CRYPTO.length})</TabsTrigger>
          </TabsList>
          {(["FOREX", "METAL", "CRYPTO"] as const).map((cls) => (
            <TabsContent key={cls} value={cls}>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                {grouped[cls].map((inst) => (
                  <Link key={inst.id} href={`/instruments/${inst.canonicalSymbol}`}>
                    <Card className="hover-elevate cursor-pointer" data-testid={`card-instrument-${inst.canonicalSymbol}`}>
                      <CardContent className="p-4">
                        <div className="flex items-center justify-between">
                          <div>
                            <span className="text-sm font-semibold">{inst.canonicalSymbol}</span>
                            <p className="text-xs text-muted-foreground mt-0.5">{inst.vendorSymbol}</p>
                          </div>
                          {inst.enabled ? (
                            <CheckCircle className="w-4 h-4 text-emerald-500" />
                          ) : (
                            <XCircle className="w-4 h-4 text-red-500" />
                          )}
                        </div>
                      </CardContent>
                    </Card>
                  </Link>
                ))}
              </div>
            </TabsContent>
          ))}
        </Tabs>
      )}
    </div>
  );
}
