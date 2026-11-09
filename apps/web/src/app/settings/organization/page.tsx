'use client';

import { Building2, ShieldCheck, UserRound } from 'lucide-react';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ErrorAlert } from '@/components/error-alert';
import { PageHeader } from '@/components/page-header';
import { StatusBadge } from '@/components/status-badge';
import { useAsync } from '@/components/use-async';
import { get, type Me } from '@/lib/api';

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
