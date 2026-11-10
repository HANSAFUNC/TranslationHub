'use client';

import { useParams, useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { CheckCheck, GitBranch, Languages, Search, Send, Undo2, Wand2 } from 'lucide-react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectGroup, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { EmptyState } from '@/components/empty-state';
import { ErrorAlert } from '@/components/error-alert';
import { PageHeader } from '@/components/page-header';
import { StatusBadge } from '@/components/status-badge';
import { timeAgo, useAsync } from '@/components/use-async';
import { get, post, type TranslationDetail, type TranslationListItem } from '@/lib/api';
import { cn } from '@/lib/utils';

const STATUS_FILTERS = ['ALL', 'DRAFT', 'PENDING_REVIEW', 'APPROVED', 'STALE', 'REJECTED'] as const;

interface ProjectLocales {
  locales: { code: string; name: string }[];
  sourceLocale: string;
}

/**
 * Translation editor: source and target side by side, context, version history, QA findings,
 * draft saving and review actions. Approving here is what produces the remote revision the
 * CLI pulls (spec §11.4).
 */
export default function TranslationsPage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;
  const router = useRouter();

  const [locale, setLocale] = useState('ALL');
  const [status, setStatus] = useState<(typeof STATUS_FILTERS)[number]>('ALL');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);

  const query = useMemo(() => {
    const map = new URLSearchParams();
    if (locale !== 'ALL') map.set('locale', locale);
    if (status !== 'ALL') map.set('status', status);
    if (search) map.set('search', search);
    map.set('limit', '100');
    return map.toString();
  }, [locale, status, search]);

  const { data: project } = useAsync(() => get<ProjectLocales>(`/projects/${projectId}`), [projectId]);
  const {
    data: list,
    error,
    loading,
    reload,
  } = useAsync(
    () => get<{ items: TranslationListItem[]; nextCursor: string | null }>(`/projects/${projectId}/translations?${query}`),
    [projectId, query],
  );
  const { data: detail, reload: reloadDetail } = useAsync(
    () => (selected ? get<TranslationDetail>(`/projects/${projectId}/translations/${selected}`) : Promise.resolve(null)),
    [projectId, selected],
  );

  async function run(key: string, action: () => Promise<unknown>, message: string) {
    setBusy(key);
    setActionError(null);
    try {
      await action();
      toast.success(message);
      await Promise.all([reload(), reloadDetail()]);
    } catch (err) {
      setActionError(err);
    } finally {
      setBusy(null);
    }
  }

  function select(entry: TranslationListItem) {
    setSelected(entry.entryId);
    setDraft(entry.value);
    setActionError(null);
  }

  return (
    <>
      <PageHeader
        title="翻译编辑器"
        description="原文与译文并排；保存草稿后提交审核，审核通过 CLI 才能拉取回写"
        actions={
          <Button variant="outline" onClick={() => router.push(`/projects/${projectId}/sync`)}>
            <GitBranch />
            仓库同步
          </Button>
        }
      />

      <FieldGroup className="mb-4 grid gap-3 sm:grid-cols-3">
        <Field>
          <FieldLabel>语言</FieldLabel>
          <Select value={locale} onValueChange={setLocale}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="全部语言" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="ALL">全部语言</SelectItem>
                {project?.locales.map((item) => (
                  <SelectItem key={item.code} value={item.code}>
                    {item.code} {item.name !== item.code ? `· ${item.name}` : ''}
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
                {STATUS_FILTERS.map((item) => (
                  <SelectItem key={item} value={item}>
                    {item}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
        <Field>
          <FieldLabel htmlFor="search">搜索 Key</FieldLabel>
          <div className="relative">
            <Search className="text-muted-foreground absolute left-2 top-2.5 size-4" />
            <Input
              id="search"
              className="pl-8"
              placeholder="checkout.pay_now"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
        </Field>
      </FieldGroup>

      <ErrorAlert error={error} />

      <div className={cn('grid gap-4', selected ? 'xl:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]' : '')}>
        <Card className="overflow-hidden">
          <CardHeader>
            <CardTitle className="text-base">条目</CardTitle>
            <CardDescription>{list ? `${list.items.length} 条` : '加载中…'}</CardDescription>
          </CardHeader>
          <CardContent className="px-0">
            {loading ? (
              <div className="flex flex-col gap-2 px-6">
                {Array.from({ length: 5 }).map((_, index) => (
                  <Skeleton key={index} className="h-10" />
                ))}
              </div>
            ) : list?.items.length ? (
              <ScrollArea className="max-h-[60vh]">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Key</TableHead>
                      <TableHead>Locale</TableHead>
                      <TableHead>译文</TableHead>
                      <TableHead>状态</TableHead>
                      <TableHead className="text-right">更新</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {list.items.map((entry) => (
                      <TableRow
                        key={entry.entryId}
                        onClick={() => select(entry)}
                        className={cn('cursor-pointer', selected === entry.entryId && 'bg-accent/60')}
                      >
                        <TableCell>
                          <div className="font-mono text-xs">{entry.key}</div>
                          {entry.namespace ? <div className="text-muted-foreground text-xs">{entry.namespace}</div> : null}
                        </TableCell>
                        <TableCell className="font-mono text-xs">{entry.locale}</TableCell>
                        <TableCell className="max-w-56 truncate">
                          {entry.value || <span className="text-muted-foreground">（空）</span>}
                          {entry.appliedToRepoAt ? (
                            <Badge variant="muted" className="ml-2 align-middle text-[10px]">
                              已回写
                            </Badge>
                          ) : null}
                        </TableCell>
                        <TableCell>
                          <StatusBadge status={entry.status} />
                        </TableCell>
                        <TableCell className="text-muted-foreground text-right text-xs">{timeAgo(entry.updatedAt)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </ScrollArea>
            ) : (
              <div className="px-6">
                <EmptyState
                  icon={<Languages />}
                  title="没有匹配的条目"
                  description="先在仓库里执行 localehub scan → sync preview → sync push 导入原文。"
                />
              </div>
            )}
          </CardContent>
        </Card>

        {detail ? (
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <CardTitle className="break-all font-mono text-base">{detail.key}</CardTitle>
                  <CardDescription className="font-mono text-xs">
                    {detail.platform} · {detail.locale} · {detail.namespace || '(no namespace)'} · rev {detail.revision}
                  </CardDescription>
                </div>
                <StatusBadge status={detail.status} />
              </div>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <ErrorAlert error={actionError} onDismiss={() => setActionError(null)} />

              <Tabs defaultValue="edit">
                <TabsList>
                  <TabsTrigger value="edit">编辑</TabsTrigger>
                  <TabsTrigger value="history">版本历史</TabsTrigger>
                  <TabsTrigger value="qa">QA {detail.qaIssues.length ? `(${detail.qaIssues.length})` : ''}</TabsTrigger>
                </TabsList>

                <TabsContent value="edit" className="flex flex-col gap-4">
                  <FieldGroup className="grid gap-4 md:grid-cols-2">
                    <Field>
                      <FieldLabel>原文（{project?.sourceLocale}）</FieldLabel>
                      <div className="bg-muted/50 min-h-24 whitespace-pre-wrap break-words rounded-md border p-3 font-mono text-sm">
                        {detail.source ?? '—'}
                      </div>
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="draft">译文（{detail.locale}）</FieldLabel>
                      <Textarea
                        id="draft"
                        className="min-h-24 font-mono"
                        value={draft}
                        onChange={(event) => setDraft(event.target.value)}
                      />
                    </Field>
                  </FieldGroup>

                  {detail.description ? (
                    <Field>
                      <FieldLabel>上下文 / 描述</FieldLabel>
                      <div className="text-muted-foreground text-sm">{detail.description}</div>
                    </Field>
                  ) : null}

                  <div className="flex flex-wrap gap-2">
                    <Button
                      onClick={() =>
                        run(
                          'draft',
                          () =>
                            post(`/projects/${projectId}/translations/${detail.entryId}/draft`, {
                              value: draft,
                              expectedRevision: detail.revision,
                            }),
                          '草稿已保存（新版本已创建，历史版本保留）',
                        )
                      }
                      disabled={busy !== null || draft === detail.value}
                    >
                      {busy === 'draft' ? <Spinner data-icon="inline-start" /> : <Wand2 />}
                      保存草稿
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() =>
                        run(
                          'submit',
                          () => post(`/projects/${projectId}/translations/submit`, { entryIds: [detail.entryId] }),
                          '已提交审核',
                        )
                      }
                      disabled={busy !== null || detail.status === 'PENDING_REVIEW'}
                    >
                      {busy === 'submit' ? <Spinner data-icon="inline-start" /> : <Send />}
                      提交审核
                    </Button>
                    <Button
                      onClick={() =>
                        run(
                          'approve',
                          () =>
                            post(`/projects/${projectId}/translations/review`, {
                              entryIds: [detail.entryId],
                              decision: 'APPROVE',
                            }),
                          '已审核通过：CLI 现在可以拉取该译文',
                        )
                      }
                      disabled={busy !== null || detail.status === 'APPROVED'}
                    >
                      {busy === 'approve' ? <Spinner data-icon="inline-start" /> : <CheckCheck />}
                      审核通过
                    </Button>
                    <Button
                      variant="destructive"
                      onClick={() =>
                        run(
                          'reject',
                          () =>
                            post(`/projects/${projectId}/translations/review`, {
                              entryIds: [detail.entryId],
                              decision: 'REJECT',
                            }),
                          '已退回',
                        )
                      }
                      disabled={busy !== null}
                    >
                      {busy === 'reject' ? <Spinner data-icon="inline-start" /> : <Undo2 />}
                      退回
                    </Button>
                  </div>

                  <p className="text-muted-foreground text-xs">
                    审核通过是译文能够回写本地文件的唯一入口；AI 结果永远是草稿，不能绕过这一步。
                  </p>
                </TabsContent>

                <TabsContent value="history">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-12">#</TableHead>
                        <TableHead>值</TableHead>
                        <TableHead>状态</TableHead>
                        <TableHead>来源</TableHead>
                        <TableHead className="text-right">时间</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {detail.versions.map((version) => (
                        <TableRow key={version.id}>
                          <TableCell className="font-mono text-xs">{version.version}</TableCell>
                          <TableCell className="max-w-72 whitespace-pre-wrap">{version.value}</TableCell>
                          <TableCell>
                            <StatusBadge status={version.status} />
                          </TableCell>
                          <TableCell className="text-muted-foreground text-xs">{version.authorType}</TableCell>
                          <TableCell className="text-muted-foreground text-right text-xs">{timeAgo(version.createdAt)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                  <p className="text-muted-foreground mt-3 text-xs">版本不可变：修改只会追加新版本，历史永不覆盖。</p>
                </TabsContent>

                <TabsContent value="qa">
                  {detail.qaIssues.length ? (
                    <ul className="flex flex-col gap-2">
                      {detail.qaIssues.map((issue) => (
                        <li key={issue.id} className="flex items-start gap-2 text-sm">
                          <StatusBadge status={issue.severity} />
                          <span>
                            <span className="text-muted-foreground font-mono text-xs">{issue.ruleCode}</span> {issue.message}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <EmptyState title="没有未解决的 QA 问题" description="可以在「质量中心」重新运行规则引擎。" />
                  )}
                </TabsContent>
              </Tabs>

              <Separator />
              <div className="text-muted-foreground flex flex-wrap gap-4 text-xs">
                <span>
                  content hash: <span className="font-mono">{detail.contentHash.slice(0, 16)}…</span>
                </span>
                <span>回写状态: {detail.appliedToRepoAt ? `已回写 ${timeAgo(detail.appliedToRepoAt)}` : '未回写'}</span>
              </div>
            </CardContent>
          </Card>
        ) : null}
      </div>
    </>
  );
}
