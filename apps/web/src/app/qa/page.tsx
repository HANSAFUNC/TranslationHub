'use client';

import { useState } from 'react';
import { PlayCircle, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectGroup, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EmptyState } from '@/components/empty-state';
import { ErrorAlert } from '@/components/error-alert';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { StatusBadge } from '@/components/status-badge';
import { timeAgo, useAsync } from '@/components/use-async';
import { get, post, type ProjectSummary } from '@/lib/api';

interface QaIssue {
  id: string;
  translationKey: string;
  localeCode: string;
  ruleCode: string;
  severity: string;
  message: string;
  status: string;
}

interface QaReport {
  openIssues: number;
  byRule: { ruleCode: string; severity: string; count: number }[];
  byLocale: { locale: string; count: number }[];
  recentRuns: { id: string; status: string; issueCount: number; createdAt: string }[];
}

interface QaRunResult {
  entriesScanned: number;
  issueCount: number;
  bySeverity: Record<string, number>;
}

export default function QaPage() {
  const { data: projects } = useAsync(() => get<ProjectSummary[]>('/projects'), []);
  const [projectId, setProjectId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [runResult, setRunResult] = useState<QaRunResult | null>(null);

  const effective = projectId || projects?.[0]?.id || '';
  const {
    data: issues,
    error: loadError,
    loading,
    reload,
  } = useAsync(() => (effective ? get<QaIssue[]>(`/projects/${effective}/qa/issues`) : Promise.resolve([])), [effective]);
  const { data: report, reload: reloadReport } = useAsync(
    () => (effective ? get<QaReport>(`/projects/${effective}/qa/report`) : Promise.resolve(null)),
    [effective],
  );

  async function runQa() {
    setBusy(true);
    setError(null);
    try {
      const result = await post<QaRunResult>(`/projects/${effective}/qa/run`);
      setRunResult(result);
      toast[result.bySeverity.ERROR > 0 ? 'warning' : 'success'](
        `扫描 ${result.entriesScanned} 条，发现 ${result.issueCount} 个问题`,
      );
      await Promise.all([reload(), reloadReport()]);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        title="质量中心"
        description="规则引擎在 API 与 Worker 中运行同一套实现，结果一致"
        actions={
          <>
            <Select value={effective} onValueChange={setProjectId}>
              <SelectTrigger className="w-52">
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
            <Button onClick={runQa} disabled={!effective || busy}>
              {busy ? <Spinner data-icon="inline-start" /> : <PlayCircle />}
              运行 QA
            </Button>
          </>
        }
      />

      <ErrorAlert error={loadError} />
      <ErrorAlert error={error} onDismiss={() => setError(null)} />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="未解决问题" value={report?.openIssues ?? 0} />
        <StatCard label="最近一次问题数" value={report?.recentRuns?.[0]?.issueCount ?? '—'} />
        <StatCard label="最近运行状态" value={<StatusBadge status={report?.recentRuns?.[0]?.status ?? 'PENDING'} />} />
        <StatCard
          label="本次运行"
          value={runResult ? runResult.issueCount : '—'}
          hint={runResult ? `扫描 ${runResult.entriesScanned} 条` : '点击「运行 QA」'}
        />
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">按规则聚合</CardTitle>
          </CardHeader>
          <CardContent>
            {report?.byRule.length ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>规则</TableHead>
                    <TableHead>严重度</TableHead>
                    <TableHead className="text-right">数量</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {report.byRule.map((row) => (
                    <TableRow key={`${row.ruleCode}-${row.severity}`}>
                      <TableCell className="font-mono text-xs">{row.ruleCode}</TableCell>
                      <TableCell>
                        <StatusBadge status={row.severity} />
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{row.count}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <EmptyState title="没有数据" description="运行一次 QA 即可看到聚合结果。" />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">按语言聚合</CardTitle>
          </CardHeader>
          <CardContent>
            {report?.byLocale.length ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Locale</TableHead>
                    <TableHead className="text-right">数量</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {report.byLocale.map((row) => (
                    <TableRow key={row.locale}>
                      <TableCell className="font-mono text-xs">{row.locale}</TableCell>
                      <TableCell className="text-right tabular-nums">{row.count}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <EmptyState title="没有数据" />
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <TriangleAlert className="size-4" />
            问题列表
          </CardTitle>
          <CardDescription>占位符不一致与空译文是 ERROR，会阻止发布校验通过</CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <Skeleton className="h-32" />
          ) : issues?.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>严重度</TableHead>
                  <TableHead>Key</TableHead>
                  <TableHead>Locale</TableHead>
                  <TableHead>规则</TableHead>
                  <TableHead>说明</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {issues.map((issue) => (
                  <TableRow key={issue.id}>
                    <TableCell>
                      <StatusBadge status={issue.severity} />
                    </TableCell>
                    <TableCell className="font-mono text-xs">{issue.translationKey}</TableCell>
                    <TableCell className="font-mono text-xs">{issue.localeCode}</TableCell>
                    <TableCell className="text-muted-foreground font-mono text-xs">{issue.ruleCode}</TableCell>
                    <TableCell className="text-sm">{issue.message}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <EmptyState icon={<TriangleAlert />} title="没有未解决的 QA 问题" description="规则引擎没有发现需要处理的内容。" />
          )}
        </CardContent>
      </Card>

      {report?.recentRuns.length ? (
        <Card className="mt-4">
          <CardHeader>
            <CardTitle className="text-base">最近运行</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>状态</TableHead>
                  <TableHead className="text-right">问题数</TableHead>
                  <TableHead className="text-right">时间</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.recentRuns.map((run) => (
                  <TableRow key={run.id}>
                    <TableCell>
                      <StatusBadge status={run.status} />
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{run.issueCount}</TableCell>
                    <TableCell className="text-muted-foreground text-right text-xs">{timeAgo(run.createdAt)}</TableCell>
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
