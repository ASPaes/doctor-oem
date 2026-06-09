import { Link, useRouterState } from "@tanstack/react-router";
import { LayoutDashboard, Users, Building2, Plug, ShieldCheck, Settings } from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { useRole } from "@/lib/role-context";

const items = [
  { title: "Visão Geral", url: "/", icon: LayoutDashboard, key: "dash" as const },
  { title: "Clientes", url: "/clientes", icon: Building2, key: "dash" as const },
  { title: "Usuários & Acesso", url: "/usuarios", icon: Users, key: "users" as const },
  { title: "Gateway de API", url: "/gateway", icon: Plug, key: "gateway" as const },
  { title: "Configurações", url: "/configuracoes", icon: Settings, key: "dash" as const },
];

export function AppSidebar() {
  const { state } = useSidebar();
  const collapsed = state === "collapsed";
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { canManageUsers, canAccessGateway } = useRole();

  const isActive = (url: string) =>
    url === "/" ? pathname === "/" : pathname.startsWith(url);

  const visible = items.filter((i) =>
    i.key === "users" ? canManageUsers : i.key === "gateway" ? canAccessGateway : true,
  );

  return (
    <Sidebar collapsible="icon" className="border-r border-sidebar-border">
      <SidebarHeader className="px-4 py-5">
        <div className="flex items-center gap-2">
          <div className="grid h-9 w-9 place-items-center rounded-xl bg-[image:var(--gradient-primary)] shadow-[var(--shadow-glow)]">
            <ShieldCheck className="h-5 w-5 text-primary-foreground" />
          </div>
          {!collapsed && (
            <div className="leading-tight">
              <p className="text-sm font-semibold text-gradient">NEXUS HUB</p>
              <p className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                Licenças OEM
              </p>
            </div>
          )}
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Operação</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {visible.map((item) => (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton asChild isActive={isActive(item.url)}>
                    <Link to={item.url} className="flex items-center gap-2">
                      <item.icon className="h-4 w-4" />
                      {!collapsed && <span>{item.title}</span>}
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}