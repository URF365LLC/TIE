import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { Settings as SettingsIcon, Mail, Gauge, Save } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useState, useEffect } from "react";
import type { Settings } from "@shared/schema";

export default function SettingsPage() {
  const { toast } = useToast();

  const { data: settings, isLoading } = useQuery<Settings>({
    queryKey: ["/api/settings"],
  });

  const [form, setForm] = useState({
    scanEnabled: false,
    emailEnabled: false,
    alertToEmail: "",
    smtpFrom: "",
    minScoreToAlert: 60,
    maxSymbolsPerBurst: 4,
    burstSleepMs: 1000,
    alertCooldownMinutes: 60,
  });

  useEffect(() => {
    if (settings) {
      setForm({
        scanEnabled: settings.scanEnabled,
        emailEnabled: settings.emailEnabled,
        alertToEmail: settings.alertToEmail ?? "",
        smtpFrom: settings.smtpFrom ?? "",
        minScoreToAlert: settings.minScoreToAlert,
        maxSymbolsPerBurst: settings.maxSymbolsPerBurst,
        burstSleepMs: settings.burstSleepMs,
        alertCooldownMinutes: settings.alertCooldownMinutes,
      });
    }
  }, [settings]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/settings", form);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Settings saved", description: "Your settings have been updated." });
      queryClient.invalidateQueries({ queryKey: ["/api/settings"] });
    },
    onError: (err: Error) => {
      toast({ title: "Save failed", description: err.message, variant: "destructive" });
    },
  });

  if (isLoading) {
    return (
      <div className="p-6 max-w-3xl mx-auto space-y-4">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-[200px] w-full" />
        <Skeleton className="h-[200px] w-full" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 p-6 max-w-3xl mx-auto">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight" data-testid="text-settings-title">Settings</h1>
        <p className="text-sm text-muted-foreground mt-1">Configure the scanner and alert system</p>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Gauge className="w-4 h-4 text-muted-foreground" />
            <div>
              <CardTitle className="text-base font-medium">Scanner Configuration</CardTitle>
              <CardDescription className="text-xs">Control how the background scanner operates</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="flex items-center justify-between">
            <div>
              <Label className="text-sm font-medium">Enable Scanner</Label>
              <p className="text-xs text-muted-foreground mt-0.5">Activate the background market scanner</p>
            </div>
            <Switch
              checked={form.scanEnabled}
              onCheckedChange={(v) => setForm({ ...form, scanEnabled: v })}
              data-testid="switch-scan-enabled"
            />
          </div>

          <Separator />

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label className="text-sm">Min Score to Alert</Label>
              <Input
                type="number"
                min={0}
                max={100}
                value={form.minScoreToAlert}
                onChange={(e) => setForm({ ...form, minScoreToAlert: parseInt(e.target.value) || 0 })}
                data-testid="input-min-score"
              />
              <p className="text-[11px] text-muted-foreground">Only alert for signals with score above this</p>
            </div>
            <div className="space-y-2">
              <Label className="text-sm">Symbols per Burst</Label>
              <Input
                type="number"
                min={1}
                max={10}
                value={form.maxSymbolsPerBurst}
                onChange={(e) => setForm({ ...form, maxSymbolsPerBurst: parseInt(e.target.value) || 4 })}
                data-testid="input-burst-size"
              />
              <p className="text-[11px] text-muted-foreground">Max symbols processed per burst cycle</p>
            </div>
            <div className="space-y-2">
              <Label className="text-sm">Burst Sleep (ms)</Label>
              <Input
                type="number"
                min={500}
                max={5000}
                step={100}
                value={form.burstSleepMs}
                onChange={(e) => setForm({ ...form, burstSleepMs: parseInt(e.target.value) || 1000 })}
                data-testid="input-burst-sleep"
              />
              <p className="text-[11px] text-muted-foreground">Delay between burst cycles in milliseconds</p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Mail className="w-4 h-4 text-muted-foreground" />
            <div>
              <CardTitle className="text-base font-medium">Email Alerts</CardTitle>
              <CardDescription className="text-xs">Configure email notifications for new signals</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="flex items-center justify-between">
            <div>
              <Label className="text-sm font-medium">Enable Email Alerts</Label>
              <p className="text-xs text-muted-foreground mt-0.5">Send emails when qualified signals are detected</p>
            </div>
            <Switch
              checked={form.emailEnabled}
              onCheckedChange={(v) => setForm({ ...form, emailEnabled: v })}
              data-testid="switch-email-enabled"
            />
          </div>

          <Separator />

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label className="text-sm">Alert Recipient Email</Label>
              <Input
                type="email"
                placeholder="you@example.com"
                value={form.alertToEmail}
                onChange={(e) => setForm({ ...form, alertToEmail: e.target.value })}
                data-testid="input-alert-email"
              />
            </div>
            <div className="space-y-2">
              <Label className="text-sm">From Email</Label>
              <Input
                type="email"
                placeholder="alerts@yourdomain.com"
                value={form.smtpFrom}
                onChange={(e) => setForm({ ...form, smtpFrom: e.target.value })}
                data-testid="input-smtp-from"
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label className="text-sm">Alert Cooldown (minutes)</Label>
            <Input
              type="number"
              min={1}
              max={1440}
              value={form.alertCooldownMinutes}
              onChange={(e) => setForm({ ...form, alertCooldownMinutes: parseInt(e.target.value) || 60 })}
              data-testid="input-alert-cooldown"
            />
            <p className="text-[11px] text-muted-foreground">Minimum minutes between alerts for the same symbol</p>
          </div>
          <p className="text-[11px] text-muted-foreground">
            SMTP credentials (host, port, user, pass) are configured via environment variables.
          </p>
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button
          onClick={() => saveMutation.mutate()}
          disabled={saveMutation.isPending}
          data-testid="button-save-settings"
        >
          <Save className="w-4 h-4 mr-2" />
          {saveMutation.isPending ? "Saving..." : "Save Settings"}
        </Button>
      </div>
    </div>
  );
}
