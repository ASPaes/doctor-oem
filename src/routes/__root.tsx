import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  useRouterState,
  useNavigate,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";

import appCss from "../styles.css?url";
import { reportLovableError } from "../lib/lovable-error-reporting";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import { RoleProvider } from "@/lib/role-context";
import { RoleSwitcher } from "@/components/role-switcher";
import { TenantProvider } from "@/lib/tenant-context";
import { TenantSwitcher } from "@/components/tenant-switcher";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { LogOut } from "lucide-react";
import { Toaster } from "@/components/ui/sonner";
import { Search, Bell } from "lucide-react";

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground">404</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">Page not found</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The page you're looking for doesn't exist or has been moved.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  console.error(error);
  const router = useRouter();
  useEffect(() => {
    reportLovableError(error, { boundary: "tanstack_root_error_component" });
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          This page didn't load
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Something went wrong on our end. You can try refreshing or head back home.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Try again
          </button>
          <a
            href="/"
            className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            Go home
          </a>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Nexus Hub — Gestão de Clientes e Licenças OEM" },
      { name: "description", content: "Hub central de gestão de clientes, licenças e integrações OEM com painel financeiro e gateway de APIs." },
      { name: "author", content: "Nexus Hub" },
      { property: "og:title", content: "Nexus Hub — Gestão de Clientes e Licenças OEM" },
      { property: "og:description", content: "Hub central de gestão de clientes, licenças e integrações OEM com painel financeiro e gateway de APIs." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "twitter:site", content: "@Lovable" },
      { name: "twitter:title", content: "Nexus Hub — Gestão de Clientes e Licenças OEM" },
      { name: "twitter:description", content: "Hub central de gestão de clientes, licenças e integrações OEM com painel financeiro e gateway de APIs." },
      { property: "og:image", content: "https://pub-bb2e103a32db4e198524a2e9ed8f35b4.r2.dev/83e6eae2-9036-4285-9765-e6438876afa9/id-preview-572c8bac--53a70adb-c30f-488e-9a31-b743fcbc40ab.lovable.app-1781054850626.png" },
      { name: "twitter:image", content: "https://pub-bb2e103a32db4e198524a2e9ed8f35b4.r2.dev/83e6eae2-9036-4285-9765-e6438876afa9/id-preview-572c8bac--53a70adb-c30f-488e-9a31-b743fcbc40ab.lovable.app-1781054850626.png" },
    ],
    links: [
      {
        rel: "stylesheet",
        href: appCss,
      },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [authChecked, setAuthChecked] = useState(false);
  const [hasUser, setHasUser] = useState(false);

  useEffect(() => {
    let active = true;
    supabase.auth.getUser().then(({ data }) => {
      if (!active) return;
      setHasUser(!!data.user);
      setAuthChecked(true);
    });
    const { data } = supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") {
        setHasUser(false);
        queryClient.clear();
        navigate({ to: "/auth", replace: true });
      } else if (event === "SIGNED_IN" || event === "USER_UPDATED") {
        setHasUser(true);
        queryClient.invalidateQueries();
      }
    });
    return () => {
      active = false;
      data.subscription.unsubscribe();
    };
  }, [queryClient, navigate]);

  const isAuthRoute = pathname === "/auth";

  useEffect(() => {
    if (authChecked && !hasUser && !isAuthRoute) {
      navigate({ to: "/auth", replace: true });
    }
  }, [authChecked, hasUser, isAuthRoute, navigate]);

  if (isAuthRoute) {
    return (
      <QueryClientProvider client={queryClient}>
        <Outlet />
        <Toaster />
      </QueryClientProvider>
    );
  }

  if (!authChecked || !hasUser) {
    return (
      <QueryClientProvider client={queryClient}>
        <div className="min-h-screen grid place-items-center text-sm text-muted-foreground">
          Carregando…
        </div>
      </QueryClientProvider>
    );
  }

  return (
    <QueryClientProvider client={queryClient}>
      <RoleProvider>
        <TenantProvider>
          <SidebarProvider>
          <div className="min-h-screen flex w-full">
            <AppSidebar />
            <div className="flex-1 flex flex-col min-w-0">
              <header className="h-14 flex items-center gap-3 border-b border-border glass-panel px-4 sticky top-0 z-30">
                <SidebarTrigger />
                <div className="hidden md:flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="h-1.5 w-1.5 rounded-full bg-success status-dot text-success" />
                  API OEM online · latência 84ms
                </div>
                <div className="ml-auto flex items-center gap-2">
                  <button className="hidden sm:grid h-9 w-9 place-items-center rounded-full border border-border text-muted-foreground hover:text-foreground transition">
                    <Search className="h-4 w-4" />
                  </button>
                  <button className="hidden sm:grid h-9 w-9 place-items-center rounded-full border border-border text-muted-foreground hover:text-foreground transition">
                    <Bell className="h-4 w-4" />
                  </button>
                  <TenantSwitcher />
                  <RoleSwitcher />
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={async () => {
                      await supabase.auth.signOut();
                    }}
                    title="Sair"
                  >
                    <LogOut className="h-4 w-4" />
                  </Button>
                </div>
              </header>
              <main className="flex-1">
                <Outlet />
              </main>
            </div>
          </div>
          <Toaster />
          </SidebarProvider>
        </TenantProvider>
      </RoleProvider>
    </QueryClientProvider>
  );
}
