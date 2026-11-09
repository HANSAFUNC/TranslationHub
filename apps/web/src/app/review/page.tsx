'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { CheckCheck, Languages, Undo2 } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectGroup, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { EmptyState } from '@/components/empty-state';
import { ErrorAlert } from '@/components/error-alert';
import { PageHeader } from '@/components/page-header';
import { StatusBadge } from '@/components/status-badge';
import { timeAgo, useAsync } from '@/components/use-async';
import { get, post, type ProjectSummary, type TranslationListItem } from '@/lib/api';

export default function ReviewPage() {
  const { data: projects } = useAsync(() => get<ProjectSummary[]>('/projects'), []);
  const [projectId, setProjectId] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState<'APPROVE' | 'REJECT' | null>(null);
  const [error, setError] = useState<unknown>(null);

  const effective = projectId || projects?.[0]?.id || '';
  const {
    data: queue,
    error: loadError,
    loading,
    reload,
  } = useAsync(
    () => (effective ? get<TranslationListItem[]>(`/projects/${effective}/reviews/queue`) : Promise.resolve([])),
    [effective],
  );
  const { data: stale, reload: reloadStale } = useAsync(
    () => (effective ? get<TranslationListItem[]>(`/projects/${effective}/translations/stale`) : Promise.resolve([])),
    [effective],
  );

  const allSelected = useMemo(() => Boolean(queue?.length) && selected.length === queue?.length, [queue, selected]);

  async function decide(decision: 'APPROVE' | 'REJECT') {
    if (!selected.length) return;
    setBusy(decision);
    setError(null);
    try {
      const result = await post<{ results: unknown[] }>(`/projects/${effective}/translations/review`, {
        entryIds: selected,
        decision,
      });
      toast.success(decision === 'APPROVE' ? `已通过 ${result.results.length} 条` : `已退回 ${result.results.length} 条`);
      setSelected([]);
      await Promise.all([reload(), reloadStale()]);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <PageHeader
        title="待审核"
        description="审核通过是译文能够回写本地文件的唯一入口；AI 结果不能绕过这一步"
        actions={
          <>
            <Button onClick={() => decide('APPROVE')} disabled={!selected.length || busy !== null}>
              {busy === 'APPROVE' ? <Spinner data-icon="inline-start" /> : <CheckCheck />}
              通过（{selected.length}）
            </Button>
            <Button variant="destructive" onClick={() => decide('REJECT')} disabled={!selected.length || busy !== null}>
              {busy === 'REJECT' ? <Spinner data-icon="inline-start" /> : <Undo2 />}
              退回
            </Button>
          </>
        }
      />

      <ErrorAlert error={loadError} />
      <ErrorAlert error={error} onDismiss={() => setError(null)} />

      <Field className="mb-4 flex max-w-xs flex-col gap-2">
        <FieldLabel>项目</FieldLabel>
        <Select value={effective} onValueChange={setProjectId}>
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

      <Tabs defaultValue="queue">
        <TabsList>
          <TabsTrigger value="queue">审核队列 {queue?.length ? `(${queue.length})` : ''}</TabsTrigger>
          <TabsTrigger value="stale">过期译文 {stale?.length ? `(${stale.length})` : ''}</TabsTrigger>
        </TabsList>

        <TabsContent value="queue">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">等待审核的条目</CardTitle>
              <CardDescription>勾选后可批量通过或退回；批准过期译文会被拒绝并提示重新翻译</CardDescription>
            </CardHeader>
            <CardContent>
              {loading ? (
                <div className="flex flex-col gap-2">
                  {Array.from({ length: 4 }).map((_, index) => (
                    <Skeleton key={index} className="h-10" />
                  ))}
                </div>
              ) : queue?.length ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-10">
                        <Checkbox
                          checked={allSelected}
                          onCheckedChange={(checked) => setSelected(checked ? queue.map((entry) => entry.entryId) : [])}
                          aria-label="全选"
                        />
                      </TableHead>
                      <TableHead>Key</TableHead>
                      <TableHead>Locale</TableHead>
                      <TableHead>原文</TableHead>
                      <TableHead>译文</TableHead>
                      <TableHead>状态</TableHead>
                      <TableHead className="text-right">更新</TableHead>
                      <TableHead className="text-right">操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {queue.map((entry) => (
                      <TableRow key={entry.entryId}>
                        <TableCell>
                          <Checkbox
                            checked={selected.includes(entry.entryId)}
                            onCheckedChange={(checked) =>
                              setSelected(checked ? [...selected, entry.entryId] : selected.filter((id) => id !== entry.entryId))
                            }
                            aria-label={`选择 ${entry.key}`}
                          />
                        </TableCell>
                        <TableCell className="font-mono text-xs">{entry.key}</TableCell>
                        <TableCell className="font-mono text-xs">{entry.locale}</TableCell>
                        <TableCell className="text-muted-foreground max-w-56 text-xs">{entry.source}</TableCell>
                        <TableCell className="max-w-56">
                          {entry.value || <span className="text-muted-foreground">（空）</span>}
                        </TableCell>
                        <TableCell>
                          <StatusBadge status={entry.status} />
                        </TableCell>
                        <TableCell className="text-muted-foreground text-right text-xs">{timeAgo(entry.updatedAt)}</TableCell>
                        <TableCell className="text-right">
                          <Button variant="ghost" size="sm" asChild>
                            <Link href={`/projects/${effective}/translations`}>
                              <Languages data-icon="inline-start" />
                              编辑
                            </Link>
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <EmptyState icon={<CheckCheck />} title="审核队列为空" description="翻译人员提交审核后，条目会出现在这里。" />
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="stale">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">过期译文</CardTitle>
              <CardDescription>源文在译文写完之后又变了，重新确认前默认不可回写</CardDescription>
            </CardHeader>
            <CardContent>
              {stale?.length ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Key</TableHead>
                      <TableHead>Locale</TableHead>
                      <TableHead>当前译文</TableHead>
                      <TableHead>状态</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {stale.map((entry) => (
                      <TableRow key={entry.entryId}>
                        <TableCell className="font-mono text-xs">{entry.key}</TableCell>
                        <TableCell className="font-mono text-xs">{entry.locale}</TableCell>
                        <TableCell className="max-w-72">{entry.value}</TableCell>
                        <TableCell>
                          <StatusBadge status={entry.status} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <EmptyState title="没有过期译文" description="所有译文都基于当前的源文版本。" />
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </>
  );
}
