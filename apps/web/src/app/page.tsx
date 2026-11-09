'use client';

import Link from 'next/link';
import { Activity, Boxes, GitBranch, HeartPulse, KeyRound, Languages, TriangleAlert } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EmptyState } from '@/components/empty-state';
import { ErrorAlert } from '@/components/error-alert';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { StatusBadge } from '@/components/status-badge';
import { formatDateTime, timeAgo, useAsync } from '@/components/use-async';
import { get } from '@/lib/api';

interface Overview {
  projects: number;
  keys: number;
  entries: number;
  pendingReview: number;
  conflicts: number;
  members: number;
}

interface Project {
  id: string;
  name: string;
  slug: string;
  sourceLocale: string;
  revision: number;
  counts: { keys: number; entries: number };
}

interface Session {
  id: string;
  projectName?: string;
  direction: string;
  status: string;
  baseRevision: number | null;
  revisionAfter: number | null;
  summary: unknown;
  createdAt: string;
}

interface Health {
  status: string;
  uptimeSeconds: number;
  checks: { database: boolean };
}

function summaryLine(summary: unknown): string {
  if (!summary || typeof summary !== 'object') return '—';
  const s = summary as Record<string, number>;
  const parts = [
    s.created ? `${s.created} 新增` : null,
    s.updated ? `${s.updated} 更新` : null,
    s.conflicts ? `${s.conflicts} 冲突` : null,
    s.failed ? `${s.failed} 失败` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : '无变更';
}

export default function DashboardPage() {
  const {
    data: overview,
    error: overviewError,
    loading: overviewLoading,
  } = useAsync(() => get<Overview>('/organization/overview'), []);
  const { data: projects, loading: projectsLoading } = useAsync(() => get<Project[]>('/projects'), []);
  const { data: sessions } = useAsync(() => get<Session[]>('/sync/recent-sessions?limit=8'), []);
  const { data: health } = useAsync(() => get<Health>('/health'), []);

  return (
    <>
      <PageHeader
        title="工作台"
        description="代码仓库与平台之间的本地化同步闭环状态"
        actions={
          <>
            <Button variant="outline" asChild>
              <Link href="/developers/tokens">
                <KeyRound data-icon="inline-start" />
                签发 Token
              </Link>
            </Button>
            <Button asChild>
              <Link href="/projects">
                <Boxes data-icon="inline-start" />
                项目管理
              </Link>
            </Button>
          </>
        }
      />

      <ErrorAlert error={overviewError} />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-6">
        {overviewLoading || !overview ? (
          Array.from({ length: 6 }).map((_, index) => <Skeleton key={index} className="h-24" />)
        ) : (
          <>
            <StatCard label="项目" value={overview.projects} />
            <StatCard label="翻译 Key" value={overview.keys} />
            <StatCard label="翻译条目" value={overview.entries} />
            <StatCard label="待审核" value={overview.pendingReview} />
            <StatCard
              label="未解决冲突"
              value={overview.conflicts}
              hint={overview.conflicts > 0 ? '需要人工决策' : '三方比较一致'}
            />
            <StatCard label="组织成员" value={overview.members} />
          </>
        )}
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Boxes className="size-4" />
              项目
            </CardTitle>
            <CardDescription>点击进入项目概览或直接打开同步页</CardDescription>
          </CardHeader>
          <CardContent>
            {projectsLoading ? (
              <div className="flex flex-col gap-2">
                <Skeleton className="h-9" />
                <Skeleton className="h-9" />
              </div>
            ) : projects?.length ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>项目</TableHead>
                    <TableHead>源语言</TableHead>
                    <TableHead className="text-right">Key</TableHead>
                    <TableHead className="text-right">revision</TableHead>
                    <TableHead className="text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {projects.map((project) => (
                    <TableRow key={project.id}>
                      <TableCell className="font-medium">
                        <Link href={`/projects/${project.id}`} className="hover:underline">
                          {project.name}
                        </Link>
                        <div className="text-muted-foreground font-mono text-xs">{project.slug}</div>
                      </TableCell>
                      <TableCell className="font-mono text-xs">{project.sourceLocale}</TableCell>
                      <TableCell className="text-right tabular-nums">{project.counts.keys}</TableCell>
                      <TableCell className="text-right font-mono text-xs">{project.revision}</TableCell>
                      <TableCell className="text-right">
                        <Button variant="ghost" size="sm" asChild>
                          <Link href={`/projects/${project.id}/sync`}>
                            <GitBranch data-icon="inline-start" />
                            同步
                          </Link>
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <EmptyState
                icon={<Boxes />}
                title="还没有项目"
                description="创建一个项目，然后在仓库里用 Local MCP 扫描并推送语言文件。"
                action={
                  <Button asChild>
                    <Link href="/projects">创建项目</Link>
                  </Button>
                }
              />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Activity className="size-4" />
              最近同步会话
            </CardTitle>
            <CardDescription>每次 scan / preview / push / apply 都会留下记录</CardDescription>
          </CardHeader>
          <CardContent>
            {sessions?.length ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>项目</TableHead>
                    <TableHead>方向</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead>结果</TableHead>
                    <TableHead className="text-right">时间</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sessions.map((session) => (
                    <TableRow key={session.id}>
                      <TableCell className="max-w-32 truncate">{session.projectName ?? '—'}</TableCell>
                      <TableCell className="text-muted-foreground text-xs">{session.direction}</TableCell>
                      <TableCell>
                        <StatusBadge status={session.status} />
                      </TableCell>
                      <TableCell className="text-muted-foreground text-xs">{summaryLine(session.summary)}</TableCell>
                      <TableCell className="text-muted-foreground text-right text-xs" title={formatDateTime(session.createdAt)}>
                        {timeAgo(session.createdAt)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <EmptyState
                icon={<GitBranch />}
                title="还没有同步记录"
                description="在仓库里让 Agent 调用 Local MCP 的 scan → preview → push 即可产生记录。"
              />
            )}
          </CardContent>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <HeartPulse className="size-4" />
              服务状态
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">API</span>
              <StatusBadge status={health?.status === 'ok' ? 'SUCCEEDED' : health ? 'PARTIAL' : 'PENDING'} />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">数据库</span>
              <StatusBadge status={health?.checks.database ? 'SUCCEEDED' : 'FAILED'} />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">运行时长</span>
              <span className="font-mono text-xs">{health ? `${Math.floor(health.uptimeSeconds / 60)} 分钟` : '—'}</span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <TriangleAlert className="size-4" />
              需要关注
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">未解决冲突</span>
              <Link href="/sync/conflicts" className="font-medium tabular-nums hover:underline">
                {overview?.conflicts ?? '—'}
              </Link>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">待审核译文</span>
              <Link href="/review" className="font-medium tabular-nums hover:underline">
                {overview?.pendingReview ?? '—'}
              </Link>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Languages className="size-4" />
              下一步
            </CardTitle>
            <CardDescription>从仓库接入开始的推荐顺序</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 text-sm">
            <ol className="text-muted-foreground flex list-decimal flex-col gap-1 pl-4">
              <li>在「API / MCP Token」签发含 sync.push + translation.apply 的 Token</li>
              <li>
                在仓库执行 <span className="font-mono text-xs">localehub init</span> 并导出 LOCALEHUB_TOKEN
              </li>
              <li>让 Agent 调用 scan_local_project → preview_sync → push_project_changes</li>
              <li>平台修正并审核译文，再 pull → preview_apply → apply</li>
            </ol>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
