import { QueryClient } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { Gem, LayoutDashboard, Menu, Package, Sparkles, Receipt } from "lucide-react";
import { useState } from "react";

import appCss from "../styles.css?url";
import { OfflineBanner } from "@/components/OfflineBanner";
import { QueryProvider } from "@/components/QueryProvider";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Toaster } from "@/components/ui/sonner";

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground">404</h1>
        <p className="mt-4 text-muted-foreground">Страница не найдена</p>
        <Link to="/" className="mt-6 inline-block rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground">На главную</Link>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  const router = useRouter();
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold">Что-то пошло не так</h1>
        <p className="mt-2 text-sm text-muted-foreground">{error.message}</p>
        <button onClick={() => { router.invalidate(); reset(); }} className="mt-6 rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground">Повторить</button>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Kumush_ay" },
      { name: "description", content: "Система инвентаризации ювелирного магазина с ИИ-аналитикой" },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru">
      <head><HeadContent /></head>
      <body>{children}<Scripts /></body>
    </html>
  );
}

const navItems = [
  { to: "/", label: "Baş sahypa", icon: LayoutDashboard },
  { to: "/products", label: "Katalog", icon: Package },
  { to: "/transactions", label: "Operasiýalar", icon: Receipt },
  { to: "/ai", label: "Emeli aň", icon: Sparkles },
] as const;

function AppBrand({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-gold text-gold-foreground">
        <Gem className="h-5 w-5" />
      </div>
      <div className={compact ? "min-w-0" : undefined}>
        <div className="font-serif text-lg leading-none">Kumush_ay</div>
        {!compact && <div className="text-xs text-muted-foreground">inwentarizaya</div>}
      </div>
    </div>
  );
}

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <nav className="flex-1 space-y-1 p-3">
      {navItems.map(({ to, label, icon: Icon }) => (
        <Link
          key={to}
          to={to}
          onClick={onNavigate}
          className="flex items-center gap-3 rounded-md px-3 py-2.5 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          activeProps={{ className: "bg-accent text-accent-foreground font-medium" }}
          activeOptions={{ exact: to === "/" }}
        >
          <Icon className="h-4 w-4 shrink-0" />
          {label}
        </Link>
      ))}
    </nav>
  );
}

function DesktopSidebar() {
  return (
    <aside className="fixed inset-y-0 left-0 z-40 hidden w-64 border-r bg-card md:flex md:flex-col">
      <div className="border-b px-6 py-5">
        <AppBrand />
      </div>
      <NavLinks />
      <div className="border-t p-4 text-xs text-muted-foreground">Made with ❤ by Resul Sopyyev / 2026</div>
    </aside>
  );
}

function MobileNav() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <header className="fixed inset-x-0 top-0 z-50 flex h-14 items-center gap-3 border-b bg-card/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-card/80 md:hidden">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="shrink-0"
          aria-label="Открыть меню"
          onClick={() => setOpen(true)}
        >
          <Menu className="h-5 w-5" />
        </Button>
        <AppBrand compact />
      </header>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="left" className="flex w-72 flex-col gap-0 p-0 sm:max-w-xs">
          <SheetTitle className="sr-only">Навигация</SheetTitle>
          <div className="border-b px-6 py-5">
            <AppBrand />
          </div>
          <NavLinks onNavigate={() => setOpen(false)} />
          <div className="mt-auto border-t p-4 text-xs text-muted-foreground">Made with ❤ by Resul Sopyyev / 2026</div>
        </SheetContent>
      </Sheet>
    </>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();

  return (
    <QueryProvider client={queryClient}>
      <div className="min-h-screen bg-background">
        <DesktopSidebar />
        <MobileNav />
        <main className="pt-14 md:pt-0 md:pl-64">
          <OfflineBanner />
          <Outlet />
        </main>
        <Toaster />
      </div>
    </QueryProvider>
  );
}
