import { useLocation, Link } from "wouter";
import { BarChart3, Activity, Eye, Settings, Zap } from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarHeader,
  SidebarFooter,
} from "@/components/ui/sidebar";
import { Badge } from "@/components/ui/badge";
import { useQuery } from "@tanstack/react-query";

const navItems = [
  { title: "Dashboard", url: "/", icon: BarChart3 },
  { title: "Signals", url: "/signals", icon: Zap },
  { title: "Instruments", url: "/instruments", icon: Eye },
  { title: "Settings", url: "/settings", icon: Settings },
];

export function AppSidebar() {
  const [location] = useLocation();

  const { data: scanStatus } = useQuery<{ scanEnabled: boolean; lastScanTime: string | null }>({
    queryKey: ["/api/scan/status"],
    refetchInterval: 10000,
  });

  return (
    <Sidebar>
      <SidebarHeader className="p-4">
        <div className="flex items-center gap-2">
          <div className="flex items-center justify-center w-8 h-8 rounded-md bg-primary">
            <Activity className="w-4 h-4 text-primary-foreground" />
          </div>
          <div className="flex flex-col">
            <span className="text-sm font-semibold tracking-tight">TradingEngine</span>
            <span className="text-[11px] text-muted-foreground">Intelligence Platform</span>
          </div>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Navigation</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {navItems.map((item) => {
                const isActive = location === item.url || (item.url !== "/" && location.startsWith(item.url));
                return (
                  <SidebarMenuItem key={item.title}>
                    <SidebarMenuButton asChild isActive={isActive}>
                      <Link href={item.url} data-testid={`link-nav-${item.title.toLowerCase()}`}>
                        <item.icon className="w-4 h-4" />
                        <span>{item.title}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="p-4">
        <div className="flex items-center gap-2">
          <div className={`w-2 h-2 rounded-full ${scanStatus?.scanEnabled ? "bg-status-online" : "bg-status-offline"}`} />
          <span className="text-xs text-muted-foreground">
            Scanner {scanStatus?.scanEnabled ? "Active" : "Inactive"}
          </span>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
