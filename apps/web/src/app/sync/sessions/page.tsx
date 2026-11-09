'use client';

import { Fragment, useState } from 'react';
import { ChevronDown, ChevronRight, ScrollText } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EmptyState } from '@/components/empty-state';
import { ErrorAlert } from '@/components/error-alert';
import { PageHeader } from '@/components/page-header';
import { StatusBadge } from '@/components/status-badge';
import { formatDateTime, timeAgo, useAsync } from '@/components/use-async';
import { get } from '@/lib/api';

interface Session {
  id: string;
  projectId: string;
  projectName: string;
  direction: string;
  status: string;
  baseRevision: number | null;
  revisionAfter: number | null;
  summary: Record<string, unknown> | null;
  createdAt: string;
  completedAt: string | null;
}

interface SessionDetail {
  id: string;
  planHash: string | null;
  error: string | null;
  summary: Record<string, unknown> | null;
  items: {
    translationKey: string;
    localeCode: string;
    action: string;
    status: string;
    localHash: string | null;
    remoteHash: string | null;
    baseHash: string | null;
    errorCode: string | null;
    errorMessage: string | null;
  }[];
}

function SessionDetailPanel({ id }: { id: string }) {
  const { data, error } = useAsync(() => get<SessionDetail>(`/sync/sessions/${id}`), [id]);
  if (error) return <ErrorAlert error={error} />;
  if (!data) return <Skeleton className="h-32" />;
  return (
    <div className="flex flex-col gap-4">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">plan hash</dt>
        <dd className="break-all font-mono text-xs">{data.planHash ?? '—'}</dd>
        <dt className="text-muted-foreground">error</dt>
        <dd>{data.error ?? '—'}</dd>
      </dl>
      {data.items.length ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Key</TableHead>
              <TableHead>Locale</TableHead>
              <TableHead>动作</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>local / remote / base</TableHead>
              <TableHead>错误</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.items.map((item, index) => (
              <TableRow key={`${item.translationKey}-${item.localeCode}-${index}`}>
                <TableCell className="font-mono text-xs">{item.translationKey}</TableCell>
                <TableCell className="font-mono text-xs">{item.localeCode}</TableCell>
                <TableCell>
                  <StatusBadge status={item.action} />
                </TableCell>
                <TableCell>
                  <StatusBadge status={item.status} />
                </TableCell>
                <TableCell className="text-muted-foreground font-mono text-xs">
                  {(item.localHash ?? '—').slice(0, 8)} / {(item.remoteHash ?? '—').slice(0, 8)} /{' '}
                  {(item.baseHash ?? '—').slice(0, 8)}
                </TableCell>
                <TableCell className="text-destructive text-xs">{item.errorMessage ?? item.errorCode ?? ''}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        <p className="text-muted-foreground text-sm">该会话没有逐条记录。</p>
      )}
    </div>
  );
}

export default function SessionsPage() {
  const { data, error, loading } = useAsync(() => get<Session[]>('/sync/recent-sessions?limit=50'), []);
  const [openId, setOpenId] = useState<string | null>(null);

  return (
    <>
      <PageHeader title="同步历史" description="每次 scan / preview / push / apply 都会留下一条会话记录" />
      <ErrorAlert error={error} />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ScrollText className="size-4" />
            会话列表
          </CardTitle>
          <CardDescription>展开可查看逐条 Sync Item 的动作、哈希与错误</CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <Skeleton className="h-40" />
          ) : data?.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10" />
                  <TableHead>项目</TableHead>
                  <TableHead>方向</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>结果摘要</TableHead>
                  <TableHead>base → after</TableHead>
                  <TableHead className="text-right">时间</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.map((session) => {
                  const summary = (session.summary ?? {}) as Record<string, number>;
                  return (
                    <Fragment key={session.id}>
                      <TableRow>
                        <TableCell>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label="展开"
                            onClick={() => setOpenId(openId === session.id ? null : session.id)}
                          >
                            {openId === session.id ? <ChevronDown /> : <ChevronRight />}
                          </Button>
                        </TableCell>
                        <TableCell className="text-sm">{session.projectName}</TableCell>
                        <TableCell className="text-muted-foreground text-xs">{session.direction}</TableCell>
                        <TableCell>
                          <StatusBadge status={session.status} />
                        </TableCell>
                        <TableCell className="text-xs">
                          {[
                            summary.created ? `${summary.created} 新增` : null,
                            summary.updated ? `${summary.updated} 更新` : null,
                            summary.conflicts ? `${summary.conflicts} 冲突` : null,
                            summary.failed ? `${summary.failed} 失败` : null,
                          ]
                            .filter(Boolean)
                            .join(' · ') || '无变更'}
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          {session.baseRevision ?? '—'} → {session.revisionAfter ?? '—'}
                        </TableCell>
                        <TableCell className="text-muted-foreground text-right text-xs" title={formatDateTime(session.createdAt)}>
                          {timeAgo(session.createdAt)}
                        </TableCell>
                      </TableRow>
                      {openId === session.id ? (
                        <TableRow>
                          <TableCell colSpan={7} className="bg-muted/30 p-4">
                            <SessionDetailPanel id={session.id} />
                          </TableCell>
                        </TableRow>
                      ) : null}
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
          ) : (
            <EmptyState
              icon={<ScrollText />}
              title="还没有同步会话"
              description="在仓库里让 Agent 执行 scan → preview → push 即可产生记录。"
            />
          )}
        </CardContent>
      </Card>
    </>
  );
}
