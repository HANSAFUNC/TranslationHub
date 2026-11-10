'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { CircleSlash, FolderTree, MonitorSmartphone, Plug, RefreshCw, ShieldCheck, Terminal, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Select, SelectGroup, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { EmptyState } from '@/components/empty-state';
import { ErrorAlert } from '@/components/error-alert';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { StatusBadge } from '@/components/status-badge';
import { formatDateTime, timeAgo, useAsync } from '@/components/use-async';
import { get, post, type ConflictRecord, type SyncSession, type SyncStatus } from '@/lib/api';

const LAYOUT_GUIDE = [
  'scan_local_project # 扫描并上传规范化条目',
  'preview_sync # 三方比较，生成变更计划',
  'push_project_changes # confirm=true 后推送',
  'pull_platform_updates # 拉取 APPROVED 变更',
  'preview_apply # 回写 diff（dry-run）',
  'apply_translation_updates # confirm=true 后写回文件',
].join('\n');

/**
 * Repository sync page (spec §11.2).
 *
 * It is deliberately explicit about what the platform can and cannot see: heartbeats and scan
 * history are reported *by* the CLI, and the buttons that would need local access are
 * replaced with the exact command to run on the developer machine.
 */
export default function SyncPage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;

  const {
    data: status,
    error,
    loading,
    reload,
  } = useAsync(() => get<SyncStatus>(`/projects/${projectId}/sync/status`), [projectId]);
  const { data: sessions, reload: reloadSessions } = useAsync(
    () => get<SyncSession[]>(`/projects/${projectId}/sync/sessions`),
    [projectId],
  );
  const { data: conflicts, reload: reloadConflicts } = useAsync(
    () => get<ConflictRecord[]>(`/sync/conflicts?projectId=${projectId}&status=OPEN`),
    [projectId],
  );

  const [showConnect, setShowConnect] = useState(false);
  const [form, setForm] = useState({ name: 'main', repoUrl: '', defaultBranch: 'main', provider: 'local' });
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<unknown>(null);
  const [validation, setValidation] = useState<unknown>(null);

  async function createConnection(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setActionError(null);
    try {
      await post(`/projects/${projectId}/repository-connections`, {
        name: form.name,
        provider: form.provider,
        ...(form.repoUrl ? { repoUrl: form.repoUrl } : {}),
        defaultBranch: form.defaultBranch,
      });
      toast.success('仓库连接已创建');
      setShowConnect(false);
      await reload();
    } catch (err) {
      setActionError(err);
    } finally {
      setBusy(false);
    }
  }

  async function validate() {
    setBusy(true);
    setActionError(null);
    try {
      const result = await post<{ ok: boolean; counts: Record<string, number> }>(`/projects/${projectId}/sync/validate`);
      setValidation(result);
      toast[result.ok ? 'success' : 'warning'](result.ok ? '校验通过' : '校验发现问题，见下方详情');
    } catch (err) {
      setActionError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        title="仓库同步"
        description="CLI 在开发者机器上执行 scan / preview / push；平台只记录结果，不会主动访问本地磁盘"
        actions={
          <>
            <Button variant="outline" onClick={() => setShowConnect((open) => !open)}>
              <Plug />
              新建连接
            </Button>
            <Button variant="outline" onClick={validate} disabled={busy}>
              {busy ? <Spinner data-icon="inline-start" /> : <ShieldCheck />}
              同步前校验
            </Button>
            <Button
              variant="outline"
              onClick={async () => {
                await Promise.all([reload(), reloadSessions(), reloadConflicts()]);
                toast.success('已刷新');
              }}
            >
              <RefreshCw />
              刷新
            </Button>
          </>
        }
      />

      <ErrorAlert error={error} />
      <ErrorAlert error={actionError} onDismiss={() => setActionError(null)} />

      {showConnect ? (
        <Card className="mb-4">
          <CardHeader>
            <CardTitle className="text-base">新建仓库连接</CardTitle>
            <CardDescription>仓库 URL 只作为元数据展示，权限永远来自已认证的用户或 Token</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={createConnection}>
              <FieldGroup className="grid gap-4 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="name">名称</FieldLabel>
                  <Input
                    id="name"
                    value={form.name}
                    onChange={(event) => setForm({ ...form, name: event.target.value })}
                    required
                  />
                </Field>
                <Field>
                  <FieldLabel>Provider</FieldLabel>
                  <Select value={form.provider} onValueChange={(value) => setForm({ ...form, provider: value })}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {['local', 'github', 'gitlab', 'bitbucket', 'azure_devops'].map((provider) => (
                          <SelectItem key={provider} value={provider}>
                            {provider}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
                <Field>
                  <FieldLabel htmlFor="repoUrl">仓库 URL（可选）</FieldLabel>
                  <Input
                    id="repoUrl"
                    placeholder="https://github.com/acme/app"
                    value={form.repoUrl}
                    onChange={(event) => setForm({ ...form, repoUrl: event.target.value })}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="branch">默认分支</FieldLabel>
                  <Input
                    id="branch"
                    className="font-mono"
                    value={form.defaultBranch}
                    onChange={(event) => setForm({ ...form, defaultBranch: event.target.value })}
                  />
                </Field>
                <Field orientation="horizontal" className="sm:col-span-2">
                  <Button type="submit" disabled={busy}>
                    {busy ? <Spinner data-icon="inline-start" /> : null}
                    创建
                  </Button>
                  <Button type="button" variant="outline" onClick={() => setShowConnect(false)}>
                    取消
                  </Button>
                </Field>
              </FieldGroup>
            </form>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="平台 revision" value={status?.revision ?? '—'} />
        <StatCard label="同步基线" value={status?.baselineCount ?? 0} hint="connection × platform × namespace × key × locale" />
        <StatCard label="待拉取已审核译文" value={status?.pendingPlatformChanges ?? 0} />
        <StatCard label="未解决冲突" value={status?.openConflicts ?? 0} />
      </div>

      <Tabs defaultValue="connection" className="mt-6">
        <TabsList>
          <TabsTrigger value="connection">连接与映射</TabsTrigger>
          <TabsTrigger value="sessions">同步历史</TabsTrigger>
          <TabsTrigger value="conflicts">冲突 {conflicts?.length ? `(${conflicts.length})` : ''}</TabsTrigger>
          <TabsTrigger value="howto">如何同步</TabsTrigger>
        </TabsList>

        <TabsContent value="connection" className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <MonitorSmartphone className="size-4" />
                CLI 心跳
              </CardTitle>
              <CardDescription>由客户端主动上报，平台无法反向连接</CardDescription>
            </CardHeader>
            <CardContent>
              {loading ? (
                <Skeleton className="h-32" />
              ) : status?.connection ? (
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                  <dt className="text-muted-foreground">名称</dt>
                  <dd>{status.connection.name}</dd>
                  <dt className="text-muted-foreground">Provider</dt>
                  <dd>{status.connection.provider}</dd>
                  <dt className="text-muted-foreground">状态</dt>
                  <dd>
                    <StatusBadge status={status.connection.status} />
                  </dd>
                  <dt className="text-muted-foreground">分支 / commit</dt>
                  <dd className="font-mono text-xs">
                    {status.connection.lastBranch ?? '—'} / {status.connection.lastCommit?.slice(0, 8) ?? '—'}
                  </dd>
                  <dt className="text-muted-foreground">客户端</dt>
                  <dd className="text-xs">
                    {status.connection.clientName ?? '—'} {status.connection.clientVersion ?? ''}
                  </dd>
                  <dt className="text-muted-foreground">最近心跳</dt>
                  <dd title={formatDateTime(status.connection.lastSeenAt)}>{timeAgo(status.connection.lastSeenAt)}</dd>
                </dl>
              ) : (
                <EmptyState
                  icon={<MonitorSmartphone />}
                  title="还没有连接"
                  description="在仓库里运行 localehub scan 会自动注册连接。"
                />
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <FolderTree className="size-4" />
                文件映射
              </CardTitle>
              <CardDescription>写入目标必须同时命中映射与 workspace.allowWrite</CardDescription>
            </CardHeader>
            <CardContent>
              {status?.fileMappings.length ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>File set</TableHead>
                      <TableHead>平台</TableHead>
                      <TableHead>Locale</TableHead>
                      <TableHead>格式</TableHead>
                      <TableHead>路径</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {status.fileMappings.map((mapping) => (
                      <TableRow key={mapping.fileSetId}>
                        <TableCell className="font-mono text-xs">{mapping.fileSetId}</TableCell>
                        <TableCell className="text-xs">{mapping.platform}</TableCell>
                        <TableCell className="font-mono text-xs">{mapping.locale ?? '—'}</TableCell>
                        <TableCell className="text-xs">{mapping.format}</TableCell>
                        <TableCell className="break-all font-mono text-xs">{mapping.paths.join(', ')}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <EmptyState icon={<FolderTree />} title="还没有扫描记录" description="扫描后这里会列出实际匹配到的语言文件。" />
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="sessions">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">同步会话</CardTitle>
            </CardHeader>
            <CardContent>
              {sessions?.length ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>状态</TableHead>
                      <TableHead>方向</TableHead>
                      <TableHead>结果</TableHead>
                      <TableHead>base → after</TableHead>
                      <TableHead>客户端</TableHead>
                      <TableHead className="text-right">时间</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sessions.map((session) => {
                      const summary = (session.summary ?? {}) as Record<string, number>;
                      return (
                        <TableRow key={session.id}>
                          <TableCell>
                            <StatusBadge status={session.status} />
                          </TableCell>
                          <TableCell className="text-muted-foreground text-xs">{session.direction}</TableCell>
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
                          <TableCell className="text-muted-foreground text-xs">
                            {(session.summary as { pushResult?: { client?: { name?: string } } } | null)?.pushResult?.client
                              ?.name ?? '—'}
                          </TableCell>
                          <TableCell className="text-muted-foreground text-right text-xs">{timeAgo(session.createdAt)}</TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              ) : (
                <EmptyState icon={<RefreshCw />} title="还没有同步会话" />
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="conflicts">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <TriangleAlert className="size-4" />
                未解决冲突
              </CardTitle>
              <CardDescription>双边同时修改且内容不同时必须人工决策</CardDescription>
            </CardHeader>
            <CardContent>
              {conflicts?.length ? (
                <>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Key</TableHead>
                        <TableHead>Locale</TableHead>
                        <TableHead>原因</TableHead>
                        <TableHead className="text-right">创建</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {conflicts.map((conflict) => (
                        <TableRow key={conflict.id}>
                          <TableCell className="font-mono text-xs">{conflict.key}</TableCell>
                          <TableCell className="font-mono text-xs">{conflict.locale}</TableCell>
                          <TableCell>
                            <StatusBadge status={conflict.reason} />
                          </TableCell>
                          <TableCell className="text-muted-foreground text-right text-xs">
                            {timeAgo(conflict.createdAt)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                  <Button className="mt-4" asChild>
                    <Link href={`/sync/conflicts?projectId=${projectId}`}>
                      <ShieldCheck data-icon="inline-start" />
                      前往冲突处理
                    </Link>
                  </Button>
                </>
              ) : (
                <EmptyState icon={<CircleSlash />} title="没有冲突" description="三方比较一致，本地与平台没有互相覆盖的风险。" />
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="howto">
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Terminal className="size-4" />
                  Agent 工具调用顺序
                </CardTitle>
                <CardDescription>同步动作全部发生在开发者机器上</CardDescription>
              </CardHeader>
              <CardContent>
                <pre className="bg-muted overflow-auto rounded-md p-3 font-mono text-xs">{LAYOUT_GUIDE}</pre>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">校验结果</CardTitle>
                <CardDescription>点击右上角「同步前校验」查看缺译、占位符、过期与冲突</CardDescription>
              </CardHeader>
              <CardContent>
                {validation ? (
                  <pre className="bg-muted max-h-80 overflow-auto rounded-md p-3 font-mono text-xs">
                    {JSON.stringify(validation, null, 2)}
                  </pre>
                ) : (
                  <p className="text-muted-foreground text-sm">尚未运行校验。</p>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>
    </>
  );
}
