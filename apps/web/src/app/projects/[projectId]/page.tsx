'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { GitBranch, Languages, MonitorSmartphone, Plug, Users } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EmptyState } from '@/components/empty-state';
import { ErrorAlert } from '@/components/error-alert';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { StatusBadge } from '@/components/status-badge';
import { timeAgo, useAsync } from '@/components/use-async';
import { get } from '@/lib/api';

interface ProjectDetail {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  sourceLocale: string;
  revision: number;
  locales: { id: string; code: string; name: string; isSource: boolean; status: string }[];
  platforms: { platform: string }[];
  connections: {
    id: string;
    name: string;
    provider: string;
    lastCommit: string | null;
    lastSeenAt: string | null;
    status: string;
  }[];
}

interface ProjectDashboard {
  keys: number;
  entries: number;
  locales: number;
  openConflicts: number;
  qaIssues: number;
  byStatus: Record<string, number>;
}

export default function ProjectPage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;
  const { data: project, error, loading } = useAsync(() => get<ProjectDetail>(`/projects/${projectId}`), [projectId]);
  const { data: dashboard } = useAsync(() => get<ProjectDashboard>(`/projects/${projectId}/dashboard`), [projectId]);

  if (loading) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-10 w-64" />
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-24" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <>
      <PageHeader
        title={project?.name ?? '项目'}
        description={
          <span className="font-mono text-xs">
            {project?.sourceLocale} · revision {project?.revision ?? 0} · {project?.platforms.map((p) => p.platform).join(', ')}
          </span>
        }
        actions={
          <>
            <Button variant="outline" asChild>
              <Link href={`/projects/${projectId}/sync`}>
                <GitBranch data-icon="inline-start" />
                仓库同步
              </Link>
            </Button>
            <Button asChild>
              <Link href={`/projects/${projectId}/translations`}>
                <Languages data-icon="inline-start" />
                翻译编辑器
              </Link>
            </Button>
          </>
        }
      />

      <ErrorAlert error={error} />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4 xl:grid-cols-7">
        <StatCard label="Key" value={dashboard?.keys ?? '—'} />
        <StatCard label="翻译条目" value={dashboard?.entries ?? '—'} />
        <StatCard label="语言" value={dashboard?.locales ?? '—'} />
        <StatCard label="待审核" value={dashboard?.byStatus?.PENDING_REVIEW ?? 0} />
        <StatCard label="过期译文" value={dashboard?.byStatus?.STALE ?? 0} hint="源文变更后待重新确认" />
        <StatCard label="未解决冲突" value={dashboard?.openConflicts ?? 0} />
        <StatCard label="QA 问题" value={dashboard?.qaIssues ?? 0} />
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Languages className="size-4" />
              语言配置
            </CardTitle>
            <CardDescription>源语言同时也是一个 Translation Entry，用 isSource 区分</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Locale</TableHead>
                  <TableHead>名称</TableHead>
                  <TableHead className="text-right">类型</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {project?.locales.map((locale) => (
                  <TableRow key={locale.id}>
                    <TableCell className="font-mono text-xs">{locale.code}</TableCell>
                    <TableCell>{locale.name}</TableCell>
                    <TableCell className="text-right">
                      <StatusBadge
                        status={locale.isSource ? 'APPROVED' : 'PENDING'}
                        className={locale.isSource ? '' : 'opacity-70'}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Plug className="size-4" />
              仓库连接
            </CardTitle>
            <CardDescription>心跳由客户端主动上报，平台无法直接连接开发者机器</CardDescription>
          </CardHeader>
          <CardContent>
            {project?.connections.length ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>名称</TableHead>
                    <TableHead>Provider</TableHead>
                    <TableHead>commit</TableHead>
                    <TableHead className="text-right">最近心跳</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {project.connections.map((connection) => (
                    <TableRow key={connection.id}>
                      <TableCell>{connection.name}</TableCell>
                      <TableCell className="text-muted-foreground text-xs">{connection.provider}</TableCell>
                      <TableCell className="font-mono text-xs">{connection.lastCommit?.slice(0, 8) ?? '—'}</TableCell>
                      <TableCell className="text-muted-foreground text-right text-xs">{timeAgo(connection.lastSeenAt)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <EmptyState
                icon={<MonitorSmartphone />}
                title="尚未连接仓库"
                description="在仓库根目录运行 Local MCP 的 scan_local_project，平台会自动注册连接。"
              />
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Users className="size-4" />
            同步流程速查
          </CardTitle>
        </CardHeader>
        <CardContent className="text-muted-foreground flex flex-col gap-2 text-sm">
          <p>
            推送：
            <span className="text-foreground font-mono text-xs">
              scan_local_project → preview_sync → push_project_changes(confirm=true)
            </span>
          </p>
          <Separator />
          <p>
            回写：
            <span className="text-foreground font-mono text-xs">
              pull_platform_updates → preview_apply → apply_translation_updates(confirm=true)
            </span>
          </p>
          <Separator />
          <p>默认只拉取 APPROVED 译文；双边同时修改会产生冲突并等待人工决策，不会静默覆盖。</p>
        </CardContent>
      </Card>
    </>
  );
}
