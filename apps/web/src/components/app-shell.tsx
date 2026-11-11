'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import {
  Boxes,
  Building2,
  Check,
  GitBranch,
  KeyRound,
  LayoutDashboard,
  ListChecks,
  Menu,
  Moon,
  Plug,
  ScrollText,
  ShieldCheck,
  Sun,
  TriangleAlert,
  UsersRound,
  LogOut,
  Languages,
} from 'lucide-react';

import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Separator } from '@/components/ui/separator';
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useTheme } from '@/components/theme-provider';
import { get, post, type Me } from '@/lib/api';
import { cn } from '@/lib/utils';

interface NavItem {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
}

const NAV: { group: string; items: NavItem[] }[] = [
  { group: '工作台', items: [{ href: '/', label: '概览', icon: LayoutDashboard }] },
  {
    group: '项目管理',
    items: [
      { href: '/projects', label: '所有项目', icon: Boxes },
      { href: '/settings/members', label: '组织成员', icon: UsersRound },
      { href: '/settings/audit', label: '审计日志', icon: ScrollText },
      { href: '/settings/organization', label: '组织设置', icon: Building2 },
    ],
  },
  {
    group: '翻译管理',
    items: [
      { href: '/translations', label: '所有翻译', icon: Languages },
      { href: '/review', label: '待审核', icon: ListChecks },
    ],
  },
  { group: '质量中心', items: [{ href: '/qa', label: 'QA 问题', icon: TriangleAlert }] },
  {
    group: '仓库同步',
    items: [
      { href: '/sync', label: '仓库连接', icon: GitBranch },
      { href: '/sync/sessions', label: '同步历史', icon: ScrollText },
      { href: '/sync/conflicts', label: '冲突处理', icon: ShieldCheck },
    ],
  },
  { group: '开发者', items: [{ href: '/developers/tokens', label: 'API / MCP Token', icon: KeyRound }] },
  { group: '平台', items: [{ href: '/mcp', label: 'MCP 管理', icon: Plug }] },
];

function isActive(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <nav className="flex flex-col gap-4">
      {NAV.map((group) => (
        <div key={group.group} className="flex flex-col gap-1">
          <div className="text-muted-foreground px-2 text-xs font-medium uppercase tracking-wide">{group.group}</div>
          {group.items.map((item) => {
            const active = isActive(pathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={onNavigate}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors',
                  active
                    ? 'bg-accent text-accent-foreground font-medium'
                    : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
                )}
              >
                <item.icon className="size-4 shrink-0" />
                {item.label}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

function ThemeToggle() {
  const { resolved, toggle } = useTheme();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" onClick={toggle} aria-label="切换主题">
          {resolved === 'dark' ? <Sun /> : <Moon />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{resolved === 'dark' ? '切换到浅色' : '切换到深色'}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Switch the active organization.
 *
 * The session token carries the organization, so switching means getting a new one from the API
 * and reloading — every page's data is scoped to the organization it was fetched under.
 *
 * Only rendered when the account belongs to more than one; a single-tenant user should not see a
 * menu that can only ever have one entry.
 */
function OrganizationSwitcher({ me }: { me: Me | null }) {
  const [busy, setBusy] = useState(false);
  const organizations = me?.organizations ?? [];
  if (organizations.length < 2) return null;

  async function switchTo(organizationId: string) {
    if (!me || organizationId === me.organizationId) return;
    setBusy(true);
    try {
      await post('/auth/switch-organization', { organizationId });
      // Full reload: every cached page was fetched for the previous organization.
      window.location.reload();
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : '切换失败');
      setBusy(false);
    }
  }

  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">切换组织</DropdownMenuLabel>
      {organizations.map((organization) => (
        <DropdownMenuItem
          key={organization.id}
          disabled={busy || organization.id === me?.organizationId}
          onClick={() => switchTo(organization.id)}
        >
          <Building2 data-icon="inline-start" />
          <span className="flex-1 truncate">{organization.name}</span>
          {organization.id === me?.organizationId ? <Check /> : null}
        </DropdownMenuItem>
      ))}
    </>
  );
}

function UserMenu({ me, onSignOut }: { me: Me | null; onSignOut: () => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="h-9 gap-2 px-2">
          <Avatar className="size-6">
            <AvatarFallback>{(me?.name ?? '?').slice(0, 1).toUpperCase()}</AvatarFallback>
          </Avatar>
          <span className="hidden text-sm sm:inline">{me?.name ?? '未登录'}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>
          <div className="text-sm font-medium">{me?.name ?? '—'}</div>
          <div className="text-muted-foreground font-mono text-xs">{me?.email ?? ''}</div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">组织角色：{me?.role ?? '—'}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/settings/organization">
            <Building2 data-icon="inline-start" />
            组织设置
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href="/settings/account">
            <KeyRound data-icon="inline-start" />
            账号与密码
          </Link>
        </DropdownMenuItem>
        <OrganizationSwitcher me={me} />
        <DropdownMenuItem
          variant="destructive"
          onClick={async () => {
            await post('/auth/logout').catch(() => undefined);
            onSignOut();
          }}
        >
          <LogOut />
          退出登录
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  // The session lives in an HttpOnly cookie, so the page cannot check for it directly. Asking
  // `/auth/me` is the only way to know, and a 401 there is exactly the "signed out" signal.
  const [ready, setReady] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [me, setMe] = useState<Me | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    if (pathname === '/login') {
      setReady(true);
      return;
    }
    let cancelled = false;
    setReady(false);
    void get<Me>('/auth/me')
      .then((profile) => {
        if (cancelled) return;
        setMe(profile);
        setAuthenticated(true);
      })
      .catch(() => {
        if (cancelled) return;
        setAuthenticated(false);
        router.replace('/login');
      })
      .finally(() => {
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [pathname, router]);

  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  if (pathname === '/login') return <>{children}</>;
  if (!ready || !authenticated) return null;

  return (
    <div className="bg-background min-h-svh lg:grid lg:grid-cols-[16rem_1fr]">
      {/* Desktop sidebar */}
      <aside className="bg-sidebar hidden border-r lg:sticky lg:top-0 lg:flex lg:h-svh lg:flex-col">
        <div className="flex h-14 items-center gap-2 px-4">
          <div className="bg-primary text-primary-foreground flex size-7 items-center justify-center rounded-md text-sm font-bold">
            L
          </div>
          <span className="font-semibold tracking-tight">
            Locale<span className="text-muted-foreground">Hub</span>
          </span>
        </div>
        <Separator />
        <div className="flex-1 overflow-y-auto p-3">
          <NavLinks />
        </div>
      </aside>

      <div className="flex min-w-0 flex-col">
        <header className="bg-background/95 supports-[backdrop-filter]:bg-background/70 sticky top-0 z-40 flex h-14 items-center gap-2 border-b px-4 backdrop-blur">
          {/* Mobile nav */}
          <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="lg:hidden" aria-label="打开导航">
                <Menu />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-72 p-0">
              <SheetTitle className="flex h-14 items-center gap-2 px-4">
                <div className="bg-primary text-primary-foreground flex size-7 items-center justify-center rounded-md text-sm font-bold">
                  L
                </div>
                LocaleHub
              </SheetTitle>
              <Separator />
              <div className="overflow-y-auto p-3">
                <NavLinks onNavigate={() => setMobileOpen(false)} />
              </div>
            </SheetContent>
          </Sheet>

          <div className="flex-1" />
          <ThemeToggle />
          <UserMenu me={me} onSignOut={() => router.replace('/login')} />
        </header>

        <main className="min-w-0 flex-1 p-4 sm:p-6">{children}</main>
      </div>
    </div>
  );
}
