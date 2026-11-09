'use client';

import { useMemo, useState } from 'react';
import { AlertTriangle, GitMerge, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectGroup, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { EmptyState } from '@/components/empty-state';
import { ErrorAlert } from '@/components/error-alert';
import { PageHeader } from '@/components/page-header';
import { StatusBadge } from '@/components/status-badge';
import { timeAgo, useAsync } from '@/components/use-async';
import { get, post, type ConflictRecord, type ProjectSummary } from '@/lib/api';

type Resolution = 'KEEP_LOCAL' | 'KEEP_REMOTE' | 'MANUAL_MERGE' | 'DEFER';

/**
 * Conflict resolution (spec §11.3): Base / Local / Platform three-column diff with an explicit
 * decision. Nothing merges automatically and every action is recorded with the actor.
 */
export default function ConflictsPage() {
  const { data: projects } = useAsync(() => get<ProjectSummary[]>('/projects'), []);
  const [projectId, setProjectId] = useState('');
  const [status, setStatus] = useState<'OPEN' | 'RESOLVED' | 'DEFERRED'>('OPEN');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [manualValues, setManualValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Resolution | null>(null);
  const [error, setError] = useState<unknown>(null);

  const effectiveProject = projectId || projects?.[0]?.id || '';
  const {
    data: conflicts,
    error: loadError,
    loading,
    reload,
  } = useAsync(
    () =>
      effectiveProject
        ? get<ConflictRecord[]>(`/sync/conflicts?projectId=${effectiveProject}&status=${status}`)
        : Promise.resolve([]),
    [effectiveProject, status],
  );

  const current = useMemo(
    () => conflicts?.find((conflict) => conflict.id === selectedId) ?? conflicts?.[0] ?? null,
    [conflicts, selectedId],
  );
  const others = conflicts?.filter((conflict) => conflict.id !== current?.id) ?? [];

  async function resolve(resolution: Resolution) {
    if (!current) return;
    setBusy(resolution);
    setError(null);
    try {
      const value = resolution === 'MANUAL_MERGE' ? (manualValues[current.id] ?? '').trim() : undefined;
      if (resolution === 'MANUAL_MERGE' && !value) {
        toast.error('手工合并需要填写最终值');
        return;
      }
      await post(`/sync/conflicts/${current.id}/resolve`, { resolution, value });
      toast.success(
        resolution === 'DEFER'
          ? '已标记为稍后处理'
          : resolution === 'KEEP_LOCAL'
            ? '平台已更新为本地值（新 APPROVED 版本）'
            : resolution === 'KEEP_REMOTE'
              ? '已记录采用平台值，本地需再执行 pull + apply'
              : '已写入合并值（新 APPROVED 版本）',
      );
      setSelectedId(null);
      await reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <PageHeader
        title="冲突处理"
        description="Base / Local / Platform 三栏对比；解决后产生新版本与新基线，绝不重写历史"
        actions={
          <Button
            variant="outline"
            onClick={async () => {
              await reload();
              toast.success('已刷新');
            }}
            disabled={!effectiveProject}
          >
            <ShieldCheck />
            刷新
          </Button>
        }
      />

      <ErrorAlert error={loadError} />
      <ErrorAlert error={error} onDismiss={() => setError(null)} />

      <FieldGroup className="mb-4 grid gap-3 sm:grid-cols-2">
        <Field>
          <FieldLabel>项目</FieldLabel>
          <Select value={effectiveProject} onValueChange={setProjectId}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="选择项目" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {projects?.map((project) => (
                  <SelectItem key={project.id} value={project.id}>
                    {project.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
        <Field>
          <FieldLabel>状态</FieldLabel>
          <Select value={status} onValueChange={(value) => setStatus(value as typeof status)}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="OPEN">OPEN</SelectItem>
                <SelectItem value="DEFERRED">DEFERRED</SelectItem>
                <SelectItem value="RESOLVED">RESOLVED</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
      </FieldGroup>

      {loading ? (
        <Skeleton className="h-64" />
      ) : current ? (
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <CardTitle className="break-all font-mono text-base">{current.key}</CardTitle>
                <CardDescription className="font-mono text-xs">
                  {current.platform} · {current.locale} · {current.namespace || '(no namespace)'} ·{' '}
                  {current.filePath ?? '未映射文件'}
                </CardDescription>
              </div>
              <div className="flex items-center gap-2">
                <StatusBadge status={current.reason} />
                <StatusBadge status={current.status} />
              </div>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="grid gap-3 lg:grid-cols-3">
              <div className="bg-muted/40 rounded-lg border p-3">
                <div className="text-muted-foreground mb-2 text-xs font-medium uppercase tracking-wide">Base · 上次同步</div>
                <pre className="whitespace-pre-wrap break-words font-mono text-sm">{current.baseValue ?? '—'}</pre>
              </div>
              <div className="border-warning/50 bg-warning-muted rounded-lg border p-3">
                <div className="text-muted-foreground mb-2 text-xs font-medium uppercase tracking-wide">Local · 本地文件</div>
                <pre className="whitespace-pre-wrap break-words font-mono text-sm">{current.localValue ?? '—'}</pre>
              </div>
              <div className="border-info/50 bg-info-muted rounded-lg border p-3">
                <div className="text-muted-foreground mb-2 text-xs font-medium uppercase tracking-wide">Platform · 平台</div>
                <pre className="whitespace-pre-wrap break-words font-mono text-sm">{current.remoteValue ?? '—'}</pre>
              </div>
            </div>

            <Field>
              <FieldLabel htmlFor="manual">手工合并值（仅 MANUAL_MERGE 需要）</FieldLabel>
              <Textarea
                id="manual"
                className="font-mono"
                placeholder="填写后两侧都会更新为该值"
                value={manualValues[current.id] ?? ''}
                onChange={(event) => setManualValues({ ...manualValues, [current.id]: event.target.value })}
              />
            </Field>

            <div className="flex flex-wrap gap-2">
              <Button onClick={() => resolve('KEEP_LOCAL')} disabled={busy !== null}>
                {busy === 'KEEP_LOCAL' ? <Spinner data-icon="inline-start" /> : null}
                保留本地（推送本地值到平台）
              </Button>
              <Button variant="secondary" onClick={() => resolve('KEEP_REMOTE')} disabled={busy !== null}>
                {busy === 'KEEP_REMOTE' ? <Spinner data-icon="inline-start" /> : null}
                采用平台（下次回写本地）
              </Button>
              <Button
                variant="outline"
                onClick={() => resolve('MANUAL_MERGE')}
                disabled={busy !== null || !(manualValues[current.id] ?? '').trim()}
              >
                {busy === 'MANUAL_MERGE' ? <Spinner data-icon="inline-start" /> : <GitMerge />}
                手工合并
              </Button>
              <Button variant="ghost" onClick={() => resolve('DEFER')} disabled={busy !== null}>
                稍后处理
              </Button>
            </div>

            <p className="text-muted-foreground text-xs">
              保留本地 / 手工合并会立即在平台产生一条 APPROVED 版本（新 revision 事件），随后用 Local MCP 的 preview_sync
              重新计算计划即可；采用平台只记录决策，本地文件需要 pull → preview_apply → apply 才会变化。
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="pt-6">
            <EmptyState
              icon={<ShieldCheck />}
              title={status === 'OPEN' ? '没有未解决冲突' : '没有符合条件的记录'}
              description="三方比较一致时不会产生冲突；双边同时修改且内容不同才会进入这里。"
            />
          </CardContent>
        </Card>
      )}

      {others.length ? (
        <Card className="mt-4">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <AlertTriangle className="size-4" />
              其他冲突（{others.length}）
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Key</TableHead>
                  <TableHead>Locale</TableHead>
                  <TableHead>原因</TableHead>
                  <TableHead className="text-right">创建</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {others.map((conflict) => (
                  <TableRow key={conflict.id}>
                    <TableCell className="font-mono text-xs">{conflict.key}</TableCell>
                    <TableCell className="font-mono text-xs">{conflict.locale}</TableCell>
                    <TableCell>
                      <StatusBadge status={conflict.reason} />
                    </TableCell>
                    <TableCell className="text-muted-foreground text-right text-xs">{timeAgo(conflict.createdAt)}</TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="sm" onClick={() => setSelectedId(conflict.id)}>
                        查看
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ) : null}
    </>
  );
}
