'use client';

import { useState } from 'react';
import { ScrollText, ShieldAlert } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ErrorAlert } from '@/components/error-alert';
import { PageHeader } from '@/components/page-header';
import { timeAgo, useAsync } from '@/components/use-async';
import { get, type Me } from '@/lib/api';

/**
 * Organization audit trail.
 *
 * These rows were already being written — member creation, role changes, removals, suspensions,
 * password resets — but the only endpoint that read them was project-scoped, so "who promoted
 * whom, and when" had no answer anywhere in the product.
 *
 * The filter is a prefix, so `member.` narrows to membership changes and an empty filter shows
 * everything the organization has done.
 */

interface AuditEntry {
  id: string;
  action: string;
  actorType: string;
  actor: { id: string; email: string; name: string } | null;
  mcpClient: { id: string; name: string; tokenPrefix: string; revokedAt: string | null } | null;
  resourceType: string;
  resourceId: string | null;
  projectId: string | null;
  metadata: Record<string, unknown>;
  requestId: string | null;
  createdAt: string;
}

const ACTION_LABEL: Record<string, string> = {
  'member.create': '创建账号',
  'member.add_existing': '加入组织',
  'member.role_update': '修改组织角色',
  'member.remove': '移出组织',
  'member.suspend': '暂停账号',
  'member.restore': '恢复账号',
  'member.password_reset': '重置密码',
  'member.project_role_set': '分配项目角色',
  'member.project_role_remove': '移除项目角色',
  'user.password_change': '本人修改密码',
  'organization.settings.update': '修改组织策略',
  // Written by the Remote MCP as well as by REST. `import_translations` and a REST push both
  // record `sync.push`, because they are the same operation; `via` in the metadata says which.
  'project.create': '创建项目',
  'sync.scan': '扫描仓库',
  'sync.preview': '生成推送计划',
  'sync.push': '推送变更',
  'sync.apply': '回写仓库',
  'translation.ai_translate': 'AI 生成草稿',
  'translation.review': '审核译文',
  'translation.draft_update': '修改译文草稿',
  'translation.submit_review': '提交审核',
};

/**
 * Filters are one of two shapes, because the question "what did agents do" is not a prefix of an
 * action name — it needs `actorType`.
 */
const FILTERS: { label: string; action?: string; actorType?: string }[] = [
  { label: '全部' },
  { label: '成员与权限', action: 'member.' },
  { label: '账号', action: 'user.' },
  { label: '组织策略', action: 'organization.' },
  { label: 'Agent 操作', actorType: 'mcp' },
];

export default function AuditPage() {
  const [filterIndex, setFilterIndex] = useState(0);
  const filter = FILTERS[filterIndex] ?? {};
  const { data: me } = useAsync(() => get<Me>('/auth/me'), []);
  const query = new URLSearchParams();
  if (filter.action) query.set('action', filter.action);
  if (filter.actorType) query.set('actorType', filter.actorType);
  const suffix = query.size ? `?${query.toString()}` : '';
  const { data, error, loading } = useAsync(() => get<AuditEntry[]>(`/organization/audit${suffix}`), [suffix]);

  const canRead = me ? me.isPlatformAdmin || me.role === 'ORG_OWNER' || me.role === 'ORG_ADMIN' : null;

  return (
    <>
      <PageHeader title="审计日志" description="组织内发生过的写操作：谁、什么时候、对谁做了什么" />

      <ErrorAlert error={error} />

      {canRead === false ? (
        <Alert variant="info">
          <ShieldAlert />
          <AlertTitle>无权查看</AlertTitle>
          <AlertDescription>审计日志包含成员姓名与角色变更，仅组织所有者 / 管理员可读。</AlertDescription>
        </Alert>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <ScrollText className="size-4" />
              最近的操作
            </CardTitle>
            <CardDescription>最多显示 200 条，按时间倒序</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="flex flex-wrap gap-2">
              {FILTERS.map((item, index) => (
                <Button
                  key={item.label}
                  size="sm"
                  variant={index === filterIndex ? 'default' : 'outline'}
                  onClick={() => setFilterIndex(index)}
                >
                  {item.label}
                </Button>
              ))}
            </div>

            {loading ? (
              <Skeleton className="h-48" />
            ) : data?.length ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>时间</TableHead>
                    <TableHead>操作者</TableHead>
                    <TableHead>动作</TableHead>
                    <TableHead>对象</TableHead>
                    <TableHead>详情</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.map((entry) => (
                    <TableRow key={entry.id}>
                      <TableCell className="text-muted-foreground whitespace-nowrap text-xs">
                        {timeAgo(entry.createdAt)}
                      </TableCell>
                      <TableCell className="text-xs">
                        {entry.actor ? (
                          <span className="flex flex-col gap-0.5">
                            <span className="flex items-center gap-1.5">
                              {entry.actor.name}
                              {/*
                                The row records which user a token belonged to, so without this the
                                page reads as if that person did it by hand. An agent's forty-key
                                import and a person's edit look identical otherwise.
                              */}
                              {entry.actorType === 'mcp' ? (
                                <Badge variant="outline" className="text-[10px]">
                                  Agent
                                </Badge>
                              ) : null}
                            </span>
                            <span className="text-muted-foreground font-mono text-[10px]">{entry.actor.email}</span>
                            {entry.mcpClient ? (
                              // The token, not just the person: revoking the wrong credential
                              // would stop a colleague's CI instead of the agent that misbehaved.
                              <span className="text-muted-foreground font-mono text-[10px]">
                                {entry.mcpClient.name} · {entry.mcpClient.tokenPrefix}…
                                {entry.mcpClient.revokedAt ? '（已撤销）' : ''}
                              </span>
                            ) : null}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">
                            {entry.actorType === 'mcp' ? 'Agent（Token 已删除）' : '系统'}
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge variant="muted" className="text-[10px]">
                          {ACTION_LABEL[entry.action] ?? entry.action}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground font-mono text-[10px]">
                        {entry.resourceType}
                        {entry.resourceId ? `:${entry.resourceId.slice(0, 8)}` : ''}
                      </TableCell>
                      <TableCell className="text-muted-foreground max-w-72 truncate font-mono text-[10px]">
                        {Object.keys(entry.metadata).length ? JSON.stringify(entry.metadata) : '—'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <EmptyState icon={<ScrollText />} title="没有记录" description="这个筛选条件下还没有任何操作。" />
            )}
          </CardContent>
        </Card>
      )}
    </>
  );
}
