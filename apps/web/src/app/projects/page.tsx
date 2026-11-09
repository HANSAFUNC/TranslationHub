'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Boxes, GitBranch, Languages, Plus } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EmptyState } from '@/components/empty-state';
import { ErrorAlert } from '@/components/error-alert';
import { PageHeader } from '@/components/page-header';
import { StatusBadge } from '@/components/status-badge';
import { useAsync } from '@/components/use-async';
import { get, post, type ProjectSummary } from '@/lib/api';

const EMPTY_FORM = { name: '', slug: '', sourceLocale: 'en-US', locales: 'ja-JP,zh-CN' };

export default function ProjectsPage() {
  const { data, error, loading, reload } = useAsync(() => get<ProjectSummary[]>('/projects'), []);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [formError, setFormError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setFormError(null);
    try {
      await post('/projects', {
        name: form.name,
        ...(form.slug ? { slug: form.slug } : {}),
        sourceLocale: form.sourceLocale,
        locales: form.locales
          .split(',')
          .map((locale) => locale.trim())
          .filter(Boolean),
      });
      toast.success(`项目「${form.name}」已创建`);
      setForm(EMPTY_FORM);
      setShowForm(false);
      await reload();
    } catch (err) {
      setFormError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        title="项目管理"
        description="每个项目对应一个产品，可绑定多个代码仓库连接"
        actions={
          <Button onClick={() => setShowForm((open) => !open)}>
            <Plus />
            新建项目
          </Button>
        }
      />

      <ErrorAlert error={error} />

      {showForm ? (
        <Card className="mb-4">
          <CardHeader>
            <CardTitle className="text-base">新建项目</CardTitle>
            <CardDescription>源语言是原文语言；目标语言可稍后在「语言配置」中调整</CardDescription>
          </CardHeader>
          <CardContent>
            <ErrorAlert error={formError} onDismiss={() => setFormError(null)} />
            <form onSubmit={create}>
              <FieldGroup className="grid gap-4 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="name">项目名称</FieldLabel>
                  <Input
                    id="name"
                    value={form.name}
                    onChange={(event) => setForm({ ...form, name: event.target.value })}
                    placeholder="Demo App"
                    required
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="slug">Slug（可选）</FieldLabel>
                  <Input
                    id="slug"
                    value={form.slug}
                    onChange={(event) => setForm({ ...form, slug: event.target.value })}
                    placeholder="demo-app"
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="sourceLocale">源语言（BCP 47）</FieldLabel>
                  <Input
                    id="sourceLocale"
                    className="font-mono"
                    value={form.sourceLocale}
                    onChange={(event) => setForm({ ...form, sourceLocale: event.target.value })}
                    required
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="locales">目标语言（逗号分隔）</FieldLabel>
                  <Input
                    id="locales"
                    className="font-mono"
                    value={form.locales}
                    onChange={(event) => setForm({ ...form, locales: event.target.value })}
                  />
                </Field>
                <Field orientation="horizontal" className="sm:col-span-2">
                  <Button type="submit" disabled={busy || !form.name}>
                    {busy ? <Spinner data-icon="inline-start" /> : null}
                    创建
                  </Button>
                  <Button type="button" variant="outline" onClick={() => setShowForm(false)}>
                    取消
                  </Button>
                </Field>
              </FieldGroup>
            </form>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">全部项目</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex flex-col gap-2">
              <Skeleton className="h-10" />
              <Skeleton className="h-10" />
              <Skeleton className="h-10" />
            </div>
          ) : data?.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>项目</TableHead>
                  <TableHead>源语言</TableHead>
                  <TableHead className="text-right">Key</TableHead>
                  <TableHead className="text-right">条目</TableHead>
                  <TableHead className="text-right">revision</TableHead>
                  <TableHead>我的角色</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.map((project) => (
                  <TableRow key={project.id}>
                    <TableCell>
                      <Link href={`/projects/${project.id}`} className="font-medium hover:underline">
                        {project.name}
                      </Link>
                      <div className="text-muted-foreground font-mono text-xs">{project.slug}</div>
                    </TableCell>
                    <TableCell className="font-mono text-xs">{project.sourceLocale}</TableCell>
                    <TableCell className="text-right tabular-nums">{project.counts.keys}</TableCell>
                    <TableCell className="text-right tabular-nums">{project.counts.entries}</TableCell>
                    <TableCell className="text-right font-mono text-xs">{project.revision}</TableCell>
                    <TableCell>
                      <StatusBadge status={project.role ?? 'READONLY'} />
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="sm" asChild>
                          <Link href={`/projects/${project.id}/translations`}>
                            <Languages data-icon="inline-start" />
                            翻译
                          </Link>
                        </Button>
                        <Button variant="ghost" size="sm" asChild>
                          <Link href={`/projects/${project.id}/sync`}>
                            <GitBranch data-icon="inline-start" />
                            同步
                          </Link>
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <EmptyState icon={<Boxes />} title="还没有项目" description="点击右上角「新建项目」创建第一个项目。" />
          )}
        </CardContent>
      </Card>
    </>
  );
}
