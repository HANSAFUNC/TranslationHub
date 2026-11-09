'use client';

import Link from 'next/link';
import { Boxes, Languages } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EmptyState } from '@/components/empty-state';
import { ErrorAlert } from '@/components/error-alert';
import { PageHeader } from '@/components/page-header';
import { StatusBadge } from '@/components/status-badge';
import { useAsync } from '@/components/use-async';
import { get, type ProjectSummary } from '@/lib/api';

export default function AllTranslationsPage() {
  const { data: projects, error, loading } = useAsync(() => get<ProjectSummary[]>('/projects'), []);

  return (
    <>
      <PageHeader title="所有翻译" description="选择项目进入翻译编辑器（原文/译文并排、版本历史、QA）" />
      <ErrorAlert error={error} />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">项目</CardTitle>
          <CardDescription>翻译编辑器按项目 + 语言组织条目</CardDescription>
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
                  <TableHead className="text-right">Key</TableHead>
                  <TableHead className="text-right">条目</TableHead>
                  <TableHead>我的角色</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {projects.map((project) => (
                  <TableRow key={project.id}>
                    <TableCell className="font-medium">{project.name}</TableCell>
                    <TableCell className="font-mono text-xs">{project.sourceLocale}</TableCell>
                    <TableCell className="text-right tabular-nums">{project.counts.keys}</TableCell>
                    <TableCell className="text-right tabular-nums">{project.counts.entries}</TableCell>
                    <TableCell>
                      <StatusBadge status={project.role ?? 'READONLY'} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="sm" asChild>
                        <Link href={`/projects/${project.id}/translations`}>
                          <Languages data-icon="inline-start" />
                          打开编辑器
                        </Link>
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <EmptyState
              icon={<Boxes />}
              title="还没有项目"
              description="创建项目后，用 Local MCP 把仓库里的语言文件推送上来。"
              action={
                <Button asChild>
                  <Link href="/projects">创建项目</Link>
                </Button>
              }
            />
          )}
        </CardContent>
      </Card>
    </>
  );
}
