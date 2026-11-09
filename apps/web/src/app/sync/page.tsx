'use client';

import Link from 'next/link';
import { GitBranch, ShieldCheck } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EmptyState } from '@/components/empty-state';
import { ErrorAlert } from '@/components/error-alert';
import { PageHeader } from '@/components/page-header';
import { StatusBadge } from '@/components/status-badge';
import { timeAgo, useAsync } from '@/components/use-async';
import { get, type ProjectSummary } from '@/lib/api';

interface Session {
  id: string;
  projectId: string;
  projectName: string;
  direction: string;
  status: string;
  baseRevision: number | null;
  revisionAfter: number | null;
  summary: unknown;
  createdAt: string;
}

export default function SyncOverviewPage() {
  const { data: projects, error, loading } = useAsync(() => get<ProjectSummary[]>('/projects'), []);
  const { data: sessions, loading: sessionsLoading } = useAsync(() => get<Session[]>('/sync/recent-sessions?limit=30'), []);

  return (
    <>
      <PageHeader title="仓库同步" description="选择项目查看连接、文件映射与同步历史" />
      <ErrorAlert error={error} />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">项目</CardTitle>
          <CardDescription>同步动作在开发者机器上执行，平台只记录结果</CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <Skeleton className="h-32" />
          ) : projects?.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>项目</TableHead>
                  <TableHead>源语言</TableHead>
                  <TableHead className="text-right">revision</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {projects.map((project) => (
                  <TableRow key={project.id}>
                    <TableCell className="font-medium">{project.name}</TableCell>
                    <TableCell className="font-mono text-xs">{project.sourceLocale}</TableCell>
                    <TableCell className="text-right font-mono text-xs">{project.revision}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="sm" asChild>
                          <Link href={`/projects/${project.id}/sync`}>
                            <GitBranch data-icon="inline-start" />
                            同步状态
                          </Link>
                        </Button>
                        <Button variant="ghost" size="sm" asChild>
                          <Link href={`/sync/conflicts?projectId=${project.id}`}>
                            <ShieldCheck data-icon="inline-start" />
                            冲突
                          </Link>
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <EmptyState title="还没有项目" description="先创建项目，再从仓库推送语言文件。" />
          )}
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle className="text-base">最近的同步会话</CardTitle>
        </CardHeader>
        <CardContent>
          {sessionsLoading ? (
            <Skeleton className="h-32" />
          ) : sessions?.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>项目</TableHead>
                  <TableHead>方向</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>revision</TableHead>
                  <TableHead className="text-right">时间</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sessions.map((session) => (
                  <TableRow key={session.id}>
                    <TableCell className="text-sm">{session.projectName}</TableCell>
                    <TableCell className="text-muted-foreground text-xs">{session.direction}</TableCell>
                    <TableCell>
                      <StatusBadge status={session.status} />
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {session.baseRevision ?? '—'} → {session.revisionAfter ?? '—'}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-right text-xs">{timeAgo(session.createdAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <EmptyState icon={<GitBranch />} title="还没有同步会话" />
          )}
        </CardContent>
      </Card>
    </>
  );
}
