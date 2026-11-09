'use client';

import { useState } from 'react';
import { Building2, ShieldCheck, TriangleAlert, UserRound } from 'lucide-react';
import { toast } from 'sonner';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldContent, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ErrorAlert } from '@/components/error-alert';
import { PageHeader } from '@/components/page-header';
import { StatusBadge } from '@/components/status-badge';
import { useAsync } from '@/components/use-async';
import { get, patch, type Me, type OrganizationSettings } from '@/lib/api';

const ROLE_MATRIX: [string, string][] = [
  ['ORG_OWNER / ORG_ADMIN', '组织成员、项目、AI Provider、MCP 客户端与安全策略'],
  ['PROJECT_MANAGER', '项目、语言、术语、审核流程、发布管理'],
  ['DEVELOPER', '连接仓库、导入原文、同步文件、查看问题'],
  ['PRODUCT_MANAGER', '修改原文/译文、管理上下文、发起审核'],
  ['TRANSLATOR', '编辑被分配语言的译文'],
  ['REVIEWER', '审核译文、通过或退回'],
  ['READONLY', '只读查看授权项目'],
];

export default function OrganizationSettingsPage() {
  const { data, error, loading } = useAsync(() => get<Me>('/auth/me'), []);
  const {
    data: settings,
    error: settingsError,
    loading: settingsLoading,
    reload,
  } = useAsync(() => get<OrganizationSettings>('/organization'), []);
  const [saving, setSaving] = useState(false);

  const canManage = data?.role === 'ORG_OWNER' || data?.role === 'ORG_ADMIN' || Boolean(data?.isPlatformAdmin);

  async function setDraftPolicy(allowDraftApply: boolean) {
    setSaving(true);
    try {
      await patch('/organization/settings', { allowDraftApply });
      toast.success(allowDraftApply ? '已允许回写未审核草稿' : '已禁止回写未审核草稿');
      reload();
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-10 w-56" />
        <Skeleton className="h-48" />
      </div>
    );
  }

  return (
    <>
      <PageHeader title="组织设置" description="当前组织、角色与成员权限" />
      <ErrorAlert error={error} />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <UserRound className="size-4" />
              我的账号
            </CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
              <dt className="text-muted-foreground">姓名</dt>
              <dd>{data?.name}</dd>
              <dt className="text-muted-foreground">邮箱</dt>
              <dd className="font-mono text-xs">{data?.email}</dd>
              <dt className="text-muted-foreground">组织角色</dt>
              <dd>
                <StatusBadge status={data?.role ?? 'READONLY'} />
              </dd>
              <dt className="text-muted-foreground">平台管理员</dt>
              <dd>{data?.isPlatformAdmin ? '是' : '否'}</dd>
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Building2 className="size-4" />
              我的组织
            </CardTitle>
            <CardDescription>切换组织需要在登录时选择，或由管理员调整成员关系</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>名称</TableHead>
                  <TableHead>角色</TableHead>
                  <TableHead className="text-right">当前</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data?.organizations.map((organization) => (
                  <TableRow key={organization.id}>
                    <TableCell className="text-sm">{organization.name}</TableCell>
                    <TableCell>
                      <StatusBadge status={organization.role} />
                    </TableCell>
                    <TableCell className="text-right text-xs">{organization.id === data.organizationId ? '✓' : ''}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="size-4" />
            同步安全策略
          </CardTitle>
          <CardDescription>这些开关决定 Agent 可以把什么写进开发者的仓库</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <ErrorAlert error={settingsError} />
          {settingsLoading ? (
            <Skeleton className="h-20" />
          ) : (
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="allow-draft-apply">允许回写未审核草稿（include_drafts）</FieldLabel>
                <FieldDescription>
                  关闭时（默认），Local MCP 的 <span className="font-mono">pull_platform_updates</span> 与{' '}
                  <span className="font-mono">preview_apply</span> 请求草稿会被平台拒绝，仓库里只会出现已审核（APPROVED）译文。
                </FieldDescription>
              </FieldContent>
              <Switch
                id="allow-draft-apply"
                checked={Boolean(settings?.allowDraftApply)}
                disabled={!canManage || saving}
                onCheckedChange={setDraftPolicy}
              />
            </Field>
          )}
          {settings?.allowDraftApply ? (
            <Alert variant="warning">
              <TriangleAlert />
              <AlertTitle>草稿可以覆盖已审核文案</AlertTitle>
              <AlertDescription>
                任何持有 <span className="font-mono">translation.apply</span> scope 的 Token
                都能把草稿写回仓库，且会替换掉已通过的译文。 仅在明确需要时开启。
              </AlertDescription>
            </Alert>
          ) : null}
          {!canManage && !settingsLoading ? (
            <p className="text-muted-foreground text-xs">只有组织所有者与管理员可以修改该策略。</p>
          ) : null}
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="size-4" />
            权限模型
          </CardTitle>
          <CardDescription>所有校验在服务端完成：REST API、Remote MCP、Local MCP 与 Web UI 共用同一套判断</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-64">角色</TableHead>
                <TableHead>权限摘要</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ROLE_MATRIX.map(([role, summary]) => (
                <TableRow key={role}>
                  <TableCell className="font-mono text-xs">{role}</TableCell>
                  <TableCell className="text-sm">{summary}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <Separator />
          <p className="text-muted-foreground text-xs">
            数据库对 <span className="font-mono">organization_id</span> 启用 Row Level Security，应用连接使用非 owner 角色{' '}
            <span className="font-mono">localehub_app</span>，因此租户隔离在数据库层强制执行。
          </p>
        </CardContent>
      </Card>
    </>
  );
}
