'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { CheckCheck, ChevronLeft, ChevronRight, GitBranch, Languages, Search, Send, Undo2, Wand2 } from 'lucide-react';
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
import { ScreenMockupButton, ScreenMockupDialog } from '@/components/screen-mockup-dialog';
import { StatusBadge } from '@/components/status-badge';
import { timeAgo, useAsync } from '@/components/use-async';
import { get, post, type MockupSummary, type TranslationDetail, type TranslationListItem } from '@/lib/api';
import { localeDisplayName } from '@localehub/contracts/locale';
import { cn } from '@/lib/utils';

const STATUS_FILTERS = ['ALL', 'DRAFT', 'PENDING_REVIEW', 'APPROVED', 'STALE', 'REJECTED'] as const;
/** One shared empty list: a fresh `[]` on every render would churn the dialog's effect deps. */
const NO_LOCALES: { code: string; name: string }[] = [];
const PAGE_SIZES = [50, 100, 200] as const;

interface ProjectLocales {
  locales: { code: string; name: string }[];
  sourceLocale: string;
}

interface EntryPage {
  items: TranslationListItem[];
  nextCursor: string | null;
  total: number;
}

/**
 * Translation editor: source and target side by side, context, version history, QA findings,
 * draft saving and review actions. Approving here is what produces the remote revision the
 * CLI pulls (spec §11.4).
 *
 * Both panes scroll on their own and the list pages by cursor. The list used to render the first
 * hundred entries and stop — `nextCursor` was fetched and dropped — so on a project with eight
 * thousand entries the editor showed one page and gave no way to reach the rest, and the only
 * indication of size was the length of that page.
 */
export default function TranslationsPage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;
  const router = useRouter();

  const [filters, setFilters] = useState({ locale: 'ALL', status: 'ALL' as (typeof STATUS_FILTERS)[number], search: '' });
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [pageSize, setPageSize] = useState<number>(100);
  // A stack of cursors, one entry per page visited. `nextCursor` only points forward, so "previous"
  // is the cursor the reader came from — kept here rather than re-derived, because the API has no
  // offset to compute it from.
  const [cursors, setCursors] = useState<(string | null)[]>([null]);

  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const [mockupOpen, setMockupOpen] = useState(false);
  const selectedRow = useRef<HTMLTableRowElement | null>(null);

  // Loaded here rather than next to the list because `query` below depends on it: the default
  // locale is only known once the project's source language is.
  const { data: project } = useAsync(() => get<ProjectLocales>(`/projects/${projectId}`), [projectId]);

  const pageIndex = cursors.length - 1;
  const cursor = cursors[pageIndex] ?? null;

  // Typing a key name used to fire a request per keystroke; with a count alongside every page that
  // is two queries per character.
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(filters.search), 300);
    return () => clearTimeout(timer);
  }, [filters.search]);

  const query = useMemo(() => {
    const map = new URLSearchParams();
    if (filters.locale !== 'ALL') map.set('locale', filters.locale);
    if (filters.status !== 'ALL') map.set('status', filters.status);
    if (debouncedSearch) map.set('search', debouncedSearch);
    if (cursor) map.set('cursor', cursor);
    map.set('limit', String(pageSize));
    return map.toString();
  }, [filters.locale, filters.status, debouncedSearch, cursor, pageSize]);

  const {
    data: list,
    error,
    loading,
    reload,
  } = useAsync(() => get<EntryPage>(`/projects/${projectId}/translations?${query}`), [projectId, query]);
  const { data: detail, reload: reloadDetail } = useAsync(
    () => (selected ? get<TranslationDetail>(`/projects/${projectId}/translations/${selected}`) : Promise.resolve(null)),
    [projectId, selected],
  );

  // The count on the button, refreshed when the dialog closes so it reflects a sketch an agent
  // uploaded while the page sat open. Skipped while the dialog is open: it asks the same endpoint
  // for a richer answer (`?key=` adds `containsKey`), and two identical lists in flight at once is
  // one more than this page needs.
  const { data: mockups } = useAsync(
    () => (mockupOpen ? Promise.resolve(null) : get<MockupSummary[]>(`/projects/${projectId}/mockups`)),
    [projectId, mockupOpen],
  );

  const items = list?.items ?? [];
  const total = list?.total ?? 0;
  const firstOnPage = pageIndex * pageSize + (items.length ? 1 : 0);
  const lastOnPage = pageIndex * pageSize + items.length;
  const hasNext = Boolean(list?.nextCursor);
  const hasPrevious = pageIndex > 0;

  /** Any filter change invalidates the cursor: it points into the previous result set. */
  function updateFilters(patch: Partial<typeof filters>) {
    setFilters((current) => ({ ...current, ...patch }));
    setCursors([null]);
  }

  const goNext = useCallback(() => {
    if (list?.nextCursor) setCursors((current) => [...current, list.nextCursor]);
  }, [list?.nextCursor]);

  function goPrevious() {
    setCursors((current) => (current.length > 1 ? current.slice(0, -1) : current));
  }

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
    openEntry(entry.entryId, entry.value);
  }

  /**
   * Select an entry by id, with the value the caller already has.
   *
   * The sketch dialog knows an entry's id and its text but is not part of the paged list, so it
   * cannot hand over a `TranslationListItem`. Selecting by id is what the detail pane fetches on
   * anyway, which is also why "open in the editor" works for an entry that is on another page.
   */
  function openEntry(entryId: string, value: string) {
    setSelected(entryId);
    setDraft(value);
    setActionError(null);
  }

  // Keep the chosen row visible when it was reached by keyboard rather than by click.
  useEffect(() => {
    selectedRow.current?.scrollIntoView({ block: 'nearest' });
  }, [selected, items]);

  // ↑/↓ walk the list, and ↓ past the last row turns the page. Skipped while a field has focus, so
  // arrowing inside the translation box moves the caret as usual — and skipped while the sketch dialog
  // is open, whose own buttons would otherwise move the editor's selection behind the modal (and whose
  // Escape and arrow handling must not be pre-empted by this global listener).
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (mockupOpen) return;
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      if (!items.length || event.metaKey || event.ctrlKey || event.altKey) return;
      event.preventDefault();

      const index = items.findIndex((item) => item.entryId === selected);
      if (event.key === 'ArrowUp') {
        select(items[Math.max(index - 1, 0)] ?? items[0]!);
        return;
      }
      if (index === items.length - 1) {
        goNext();
        return;
      }
      select(items[index + 1] ?? items[0]!);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [items, selected, goNext, mockupOpen]);

  return (
    <>
      <PageHeader
        title="翻译编辑器"
        description="原文与译文并排；保存草稿后提交审核，审核通过 CLI 才能拉取回写"
        actions={
          <>
            <ScreenMockupButton count={mockups?.length ?? null} onClick={() => setMockupOpen(true)} />
            <Button variant="outline" onClick={() => router.push(`/projects/${projectId}/sync`)}>
              <GitBranch />
              仓库同步
            </Button>
          </>
        }
      />

      <FieldGroup className="mb-4 grid gap-3 sm:grid-cols-3">
        <Field>
          <FieldLabel>语言</FieldLabel>
          <Select value={filters.locale} onValueChange={(value) => updateFilters({ locale: value })}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="全部语言" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="ALL">全部语言</SelectItem>
                {project?.locales.map((item) => (
                  <SelectItem key={item.code} value={item.code}>
                    {/* Derived from the code, so a locale created before the labels were translated
                        reads the same as one created after. */}
                    {item.code} · {localeDisplayName(item.code)}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
        <Field>
          <FieldLabel>状态</FieldLabel>
          <Select value={filters.status} onValueChange={(value) => updateFilters({ status: value as typeof filters.status })}>
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
              value={filters.search}
              onChange={(event) => updateFilters({ search: event.target.value })}
            />
          </div>
        </Field>
      </FieldGroup>

      <ErrorAlert error={error} />

      {/* At xl the panes fill the viewport and scroll independently — including when only the list
          is open, where `h-full` on the scroll area would otherwise resolve against an auto height
          and the whole page would scroll instead. Below xl the page scrolls as a whole, because two
          nested scroll areas on a phone is worse than one. */}
      <div className="flex flex-col gap-4 xl:h-[calc(100svh-17rem)] xl:min-h-96 xl:flex-row">
        <Card className={cn('flex min-h-0 flex-col overflow-hidden', detail ? 'xl:w-[46%] xl:shrink-0' : '')}>
          <CardHeader className="shrink-0">
            <CardTitle className="text-base">条目</CardTitle>
            <CardDescription>
              {list ? (total ? `第 ${firstOnPage}–${lastOnPage} 条，共 ${total} 条` : '没有匹配的条目') : '加载中…'}
            </CardDescription>
          </CardHeader>
          <CardContent className="min-h-0 flex-1 px-0">
            {loading ? (
              <div className="flex flex-col gap-2 px-6">
                {Array.from({ length: 5 }).map((_, index) => (
                  <Skeleton key={index} className="h-10" />
                ))}
              </div>
            ) : items.length ? (
              <ScrollArea className="h-[60vh] xl:h-full">
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
                    {items.map((entry) => (
                      <TableRow
                        key={entry.entryId}
                        ref={selected === entry.entryId ? selectedRow : undefined}
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
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t px-6 py-3">
            <div className="text-muted-foreground text-xs">↑/↓ 切换条目，到底部自动翻页</div>
            <div className="flex items-center gap-2">
              <Select value={String(pageSize)} onValueChange={(value) => { setPageSize(Number(value)); setCursors([null]); }}>
                <SelectTrigger size="sm" className="w-[104px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {PAGE_SIZES.map((size) => (
                      <SelectItem key={size} value={String(size)}>
                        每页 {size} 条
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <Button variant="outline" size="sm" onClick={goPrevious} disabled={!hasPrevious || loading}>
                <ChevronLeft data-icon="inline-start" />
                上一页
              </Button>
              <Button variant="outline" size="sm" onClick={goNext} disabled={!hasNext || loading}>
                下一页
                <ChevronRight />
              </Button>
            </div>
          </div>
        </Card>

        {detail ? (
          <Card className="flex min-h-0 flex-1 flex-col">
            <CardHeader className="shrink-0">
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
            <CardContent className="min-h-0 flex-1 overflow-hidden">
              <ScrollArea className="h-full pr-3">
                <div className="flex flex-col gap-4">
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
                          <div className="bg-muted/50 max-h-64 min-h-24 overflow-auto whitespace-pre-wrap break-words rounded-md border p-3 font-mono text-sm">
                            {detail.source ?? '—'}
                          </div>
                        </Field>
                        <Field>
                          <FieldLabel htmlFor="draft">译文（{detail.locale}）</FieldLabel>
                          <Textarea
                            id="draft"
                            className="max-h-64 min-h-24 font-mono"
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
                </div>
              </ScrollArea>
            </CardContent>
          </Card>
        ) : null}
      </div>

      <ScreenMockupDialog
        projectId={projectId}
        open={mockupOpen}
        onOpenChange={setMockupOpen}
        locales={project?.locales ?? NO_LOCALES}
        sourceLocale={project?.sourceLocale}
        defaultLocale={filters.locale !== 'ALL' && filters.locale !== project?.sourceLocale ? filters.locale : null}
        focusEntryId={selected}
        focusKey={detail?.key ?? null}
        focusNamespace={detail?.namespace ?? null}
        onOpenInEditor={(entry) => {
          openEntry(entry.entryId, entry.value);
          setMockupOpen(false);
        }}
      />
    </>
  );
}
