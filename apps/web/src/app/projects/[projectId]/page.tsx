'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Copy, GitBranch, Languages, MonitorSmartphone, Plug, Settings2, Trash2, Users } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldSet } from '@/components/ui/field';
import { EmptyState } from '@/components/empty-state';
import { ErrorAlert } from '@/components/error-alert';
import { LocalePicker } from '@/components/locale-picker';
import { PageHeader } from '@/components/page-header';
import { PlatformPicker } from '@/components/platform-picker';
import { StatCard } from '@/components/stat-card';
import { StatusBadge } from '@/components/status-badge';
import { timeAgo, useAsync } from '@/components/use-async';
import { del, get, patch, post } from '@/lib/api';
import { localeDisplayName } from '@localehub/contracts/locale';
import { toast } from 'sonner';

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

interface SettingsForm {
  name: string;
  description: string;
  platforms: string[];
  sourceLocale: string;
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
  const { data: project, error, loading, reload } = useAsync(() => get<ProjectDetail>(`/projects/${projectId}`), [projectId]);
  const { data: dashboard, reload: reloadDashboard } = useAsync(
    () => get<ProjectDashboard>(`/projects/${projectId}/dashboard`),
    [projectId],
  );

  const [busy, setBusy] = useState<string | null>(null);
  const [localeError, setLocaleError] = useState<unknown>(null);
  const [settingsError, setSettingsError] = useState<unknown>(null);
  const [pendingLocale, setPendingLocale] = useState('');
  const [settings, setSettings] = useState<SettingsForm | null>(null);

  const hasEntries = (dashboard?.entries ?? 0) > 0;
  const fromProject: SettingsForm | null = project
    ? {
        name: project.name,
        description: project.description ?? '',
        platforms: project.platforms.map((row) => row.platform),
        sourceLocale: project.sourceLocale,
      }
    : null;
  const current: SettingsForm = settings ?? fromProject ?? { name: '', description: '', platforms: ['web'], sourceLocale: '' };

  function resetSettings() {
    setSettings(null);
    setSettingsError(null);
  }

  async function saveSettings() {
    setBusy('settings');
    setSettingsError(null);
    try {
      await patch(`/projects/${projectId}`, {
        name: current.name,
        description: current.description || null,
        platforms: current.platforms,
        // Only sent when the project is still empty; the API refuses it otherwise, and sending it
        // anyway would turn a read-only field into a failed save.
        ...(hasEntries ? {} : { sourceLocale: current.sourceLocale }),
      });
      toast.success('项目设置已保存');
      setSettings(null);
      await Promise.all([reload(), reloadDashboard()]);
    } catch (err) {
      setSettingsError(err);
    } finally {
      setBusy(null);
    }
  }

  async function addLocale() {
    if (!pendingLocale) return;
    setBusy('add');
    setLocaleError(null);
    try {
      await post(`/projects/${projectId}/locales`, { code: pendingLocale });
      toast.success(`已添加 ${pendingLocale}`);
      setPendingLocale('');
      await Promise.all([reload(), reloadDashboard()]);
    } catch (err) {
      setLocaleError(err);
    } finally {
      setBusy(null);
    }
  }

  async function removeLocale(code: string) {
    setBusy(code);
    setLocaleError(null);
    try {
      await del(`/projects/${projectId}/locales/${encodeURIComponent(code)}`);
      toast.success(`已移除 ${code}`);
      await Promise.all([reload(), reloadDashboard()]);
    } catch (err) {
      setLocaleError(err);
    } finally {
      setBusy(null);
    }
  }

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
          // The project id is shown because it is what every MCP tool takes as its first argument.
          // It used to be invisible: the only way to obtain it was `list_projects` over MCP or a
          // look at the URL, which is a poor answer to "what do I put in project_id".
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs">
              {project?.sourceLocale ? localeDisplayName(project.sourceLocale) : ''} · revision {project?.revision ?? 0} ·{' '}
              {project?.platforms.map((p) => p.platform).join(', ')}
            </span>
            <button
              type="button"
              className="bg-muted/60 hover:bg-muted flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[11px]"
              onClick={async () => {
                await navigator.clipboard.writeText(projectId);
                toast.success('已复制 project_id');
              }}
              aria-label="复制 project_id"
            >
              <Copy className="size-3" />
              {projectId}
            </button>
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
            <CardDescription>
              源语言是原文语言，其余都是目标语言。仓库里出现项目没有的语言时，导入会自动补上。
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Locale</TableHead>
                  <TableHead>名称</TableHead>
                  <TableHead className="text-right">类型</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {project?.locales.map((locale) => (
                  <TableRow key={locale.id}>
                    <TableCell className="font-mono text-xs">{locale.code}</TableCell>
                    {/* The label is derived from the code, so a language created before the labels
                        were translated (stored as `한국어`) reads the same as one created after. */}
                    <TableCell>{localeDisplayName(locale.code) || locale.name}</TableCell>
                    <TableCell className="text-right">
                      <StatusBadge status={locale.isSource ? 'APPROVED' : 'PENDING'} className={locale.isSource ? '' : 'opacity-70'} />
                    </TableCell>
                    <TableCell className="text-right">
                      {locale.isSource ? null : (
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`移除 ${locale.code}`}
                          disabled={busy === locale.code}
                          onClick={() => removeLocale(locale.code)}
                        >
                          {busy === locale.code ? <Spinner /> : <Trash2 />}
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            <ErrorAlert error={localeError} onDismiss={() => setLocaleError(null)} />

            <Separator />

            <div className="flex flex-col gap-3">
              <Field>
                <FieldLabel>添加语言</FieldLabel>
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <LocalePicker
                      value={pendingLocale}
                      onChange={setPendingLocale}
                      exclude={project?.locales.map((locale) => locale.code) ?? []}
                      placeholder="选择要添加的语言"
                    />
                  </div>
                  <Button type="button" disabled={!pendingLocale || busy === 'add'} onClick={addLocale}>
                    {busy === 'add' ? <Spinner data-icon="inline-start" /> : null}
                    添加
                  </Button>
                </div>
                <FieldDescription>
                  语言代码一旦有译文就不再改动。已存在同一语言时（例如已有 zh-CN 再添加 zh-Hans）会被拒绝，避免译文被拆到两个语言下。
                </FieldDescription>
              </Field>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Settings2 className="size-4" />
              项目设置
            </CardTitle>
            <CardDescription>名称、描述与平台。平台决定 Key 的身份，改动会影响之后的同步</CardDescription>
          </CardHeader>
          <CardContent>
            <ErrorAlert error={settingsError} onDismiss={() => setSettingsError(null)} />
            <FieldSet>
              <FieldGroup className="gap-4">
                <Field>
                  <FieldLabel htmlFor="project-name">项目名称</FieldLabel>
                  <Input id="project-name" value={current.name} onChange={(event) => setSettings({ ...current, name: event.target.value })} />
                </Field>
                <Field>
                  <FieldLabel htmlFor="project-description">描述</FieldLabel>
                  <Textarea
                    id="project-description"
                    rows={2}
                    value={current.description}
                    onChange={(event) => setSettings({ ...current, description: event.target.value })}
                  />
                </Field>
                <Field>
                  <FieldLabel>平台</FieldLabel>
                  <PlatformPicker value={current.platforms} onChange={(platforms) => setSettings({ ...current, platforms })} />
                </Field>
                <Field>
                  <FieldLabel htmlFor="project-source">源语言</FieldLabel>
                  <LocalePicker
                    id="project-source"
                    value={current.sourceLocale}
                    onChange={(sourceLocale) => setSettings({ ...current, sourceLocale })}
                    exclude={project?.locales.filter((locale) => !locale.isSource).map((locale) => locale.code) ?? []}
                    disabled={hasEntries}
                  />
                  <FieldDescription>
                    {hasEntries
                      ? `项目已有 ${dashboard?.entries ?? 0} 条译文，源语言是它们的依据，不能再改。`
                      : '还没有译文，可以改。一旦导入或推送了内容就固定。'}
                  </FieldDescription>
                </Field>
                <Field orientation="horizontal">
                  <Button type="button" disabled={busy === 'settings' || !current.name} onClick={saveSettings}>
                    {busy === 'settings' ? <Spinner data-icon="inline-start" /> : null}
                    保存
                  </Button>
                  <Button type="button" variant="outline" onClick={resetSettings} disabled={busy === 'settings'}>
                    还原
                  </Button>
                </Field>
              </FieldGroup>
            </FieldSet>
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
                description="在仓库根目录运行 localehub scan，平台会自动注册连接。"
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
