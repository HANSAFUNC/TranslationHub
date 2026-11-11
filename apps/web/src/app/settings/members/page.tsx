'use client';

import { useState } from 'react';
import { Ban, KeyRound, Plus, RotateCcw, Save, ShieldCheck, Trash2, UserPlus, UsersRound } from 'lucide-react';
import { toast } from 'sonner';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { EmptyState } from '@/components/empty-state';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ErrorAlert } from '@/components/error-alert';
import { PageHeader } from '@/components/page-header';
import { timeAgo, useAsync } from '@/components/use-async';
import { del, get, patch, post, put, type Me } from '@/lib/api';

/**
 * Organization members.
 *
 * Accounts are created here, by an admin: there is no invitation flow and no open registration on
 * a live instance. That is why the form asks for an initial password — the person cannot sign
 * themselves up.
 *
 * Role options are filtered to what the signed-in admin may actually grant, because the API
 * refuses an attempt to hand out a role above your own (an ORG_ADMIN cannot mint an ORG_OWNER).
 * Showing the option and then failing would be a worse UI than not showing it.
 */

const ORG_ROLE_LABEL: Record<string, string> = {
  ORG_OWNER: '组织所有者',
  ORG_ADMIN: '组织管理员',
  PROJECT_MANAGER: '项目经理',
  DEVELOPER: '开发者',
  PRODUCT_MANAGER: '产品经理',
  TRANSLATOR: '翻译',
  REVIEWER: '审核员',
  READONLY: '只读',
};

const ORG_ROLE_HINT: Record<string, string> = {
  ORG_OWNER: '组织成员、项目、Token 与安全策略；唯一所有者不能降级或移除',
  ORG_ADMIN: '与所有者相同，但不能授予或管理所有者',
  PROJECT_MANAGER: '项目、语言、术语、审核流程、发布管理',
  DEVELOPER: '连接仓库、导入原文、同步文件、查看问题',
  PRODUCT_MANAGER: '修改原文/译文、管理上下文、发起审核',
  TRANSLATOR: '编辑被分配语言的译文',
  REVIEWER: '审核译文、通过或退回',
  READONLY: '只读查看授权项目',
};

const PROJECT_ROLE_LABEL: Record<string, string> = {
  PROJECT_MANAGER: '项目经理',
  DEVELOPER: '开发者',
  PRODUCT_MANAGER: '产品经理',
  TRANSLATOR: '翻译',
  REVIEWER: '审核员',
  READONLY: '只读',
};

/** Roles this actor is allowed to hand out. Mirrors `canGrantOrgRole` on the server. */
const GRANTABLE: Record<string, string[]> = {
  ORG_OWNER: ['ORG_OWNER', 'ORG_ADMIN', 'PROJECT_MANAGER', 'DEVELOPER', 'PRODUCT_MANAGER', 'TRANSLATOR', 'REVIEWER', 'READONLY'],
  ORG_ADMIN: ['ORG_ADMIN', 'PROJECT_MANAGER', 'DEVELOPER', 'PRODUCT_MANAGER', 'TRANSLATOR', 'REVIEWER', 'READONLY'],
};

interface MemberProject {
  projectId: string;
  projectName: string;
  role: string;
  localeScope: string[];
}

interface Member {
  userId: string;
  email: string;
  name: string;
  role: string;
  isPlatformAdmin: boolean;
  lastLoginAt: string | null;
  /** Set while the account is suspended: it keeps its roles but every credential stops working. */
  deactivatedAt: string | null;
  joinedAt: string;
  projects: MemberProject[];
}

interface ProjectSummary {
  id: string;
  name: string;
}

export default function MembersPage() {
  const { data: me } = useAsync(() => get<Me>('/auth/me'), []);
  const { data: members, error, loading, reload } = useAsync(() => get<Member[]>('/organization/members'), []);
  const { data: projects } = useAsync(() => get<ProjectSummary[]>('/projects'), []);

  // `null` while `/auth/me` is in flight, so the page does not flash a "no permission" state.
  const canManage = me ? me.isPlatformAdmin || me.role === 'ORG_OWNER' || me.role === 'ORG_ADMIN' : null;
  const grantable = me?.isPlatformAdmin ? Object.keys(ORG_ROLE_LABEL) : me?.role ? (GRANTABLE[me.role] ?? []) : [];

  return (
    <>
      <PageHeader title="组织成员" description="在这里创建账号并分配角色；平台不开放外部注册，也没有邀请链接" />

      <ErrorAlert error={error} />

      {canManage === false ? (
        <Alert variant="info" className="mb-4">
          <ShieldCheck />
          <AlertTitle>只读</AlertTitle>
          <AlertDescription>
            只有组织所有者 / 管理员可以新增成员和调整角色。你仍然可以在自己的项目里分配项目成员。
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
        <Card className="min-w-0">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <UsersRound className="size-4" />
              成员 {members ? `(${members.length})` : ''}
            </CardTitle>
            <CardDescription>角色决定这个人能做什么；项目角色只影响单个项目</CardDescription>
          </CardHeader>
          <CardContent>
            {loading ? (
              <Skeleton className="h-48" />
            ) : members?.length ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>成员</TableHead>
                    <TableHead>组织角色</TableHead>
                    <TableHead>项目</TableHead>
                    <TableHead>最近登录</TableHead>
                    {canManage ? <TableHead className="text-right">操作</TableHead> : null}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {members.map((member) => (
                    <MemberRow
                      key={member.userId}
                      member={member}
                      me={me}
                      canManage={Boolean(canManage)}
                      grantable={grantable}
                      projects={projects ?? []}
                      onChanged={reload}
                    />
                  ))}
                </TableBody>
              </Table>
            ) : (
              <EmptyState icon={<UsersRound />} title="还没有成员" description="用右侧的表单创建第一个账号。" />
            )}
          </CardContent>
        </Card>

        <div className="flex min-w-0 flex-col gap-4">
          {canManage ? <AddMemberCard grantable={grantable} onAdded={reload} /> : null}
          <RoleLegend />
        </div>
      </div>
    </>
  );
}

function MemberRow({
  member,
  me,
  canManage,
  grantable,
  projects,
  onChanged,
}: {
  member: Member;
  me: Me | null | undefined;
  canManage: boolean;
  grantable: string[];
  projects: ProjectSummary[];
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const isSelf = me?.id === member.userId;
  // The server refuses these too; hiding them keeps a click from ending in a 403 toast.
  const mayTouch = canManage && !isSelf && (me?.isPlatformAdmin || grantable.includes(member.role));

  async function changeRole(role: string) {
    if (role === member.role) return;
    setBusy(true);
    try {
      await patch(`/organization/members/${member.userId}`, { role });
      toast.success(`${member.name} 的角色已改为 ${ORG_ROLE_LABEL[role] ?? role}`);
      onChanged();
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : '修改失败');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm(`把 ${member.email} 移出组织？这会同时删除其项目角色。`)) return;
    setBusy(true);
    try {
      await del(`/organization/members/${member.userId}`);
      toast.success('已移出组织');
      onChanged();
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : '移除失败');
    } finally {
      setBusy(false);
    }
  }

  async function toggleSuspend() {
    const suspend = !member.deactivatedAt;
    if (
      suspend &&
      !window.confirm(`暂停 ${member.email}？该账号现有的会话与 MCP Token 会立即失效，但成员关系与项目角色会保留。`)
    ) {
      return;
    }
    setBusy(true);
    try {
      await patch(`/organization/members/${member.userId}/status`, { deactivated: suspend });
      toast.success(suspend ? '账号已暂停' : '账号已恢复');
      onChanged();
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : '操作失败');
    } finally {
      setBusy(false);
    }
  }

  async function resetPassword() {
    const password = window.prompt(`为 ${member.email} 设置新密码（至少 10 位）`);
    if (!password) return;
    setBusy(true);
    try {
      await post(`/organization/members/${member.userId}/password`, { password });
      toast.success('密码已重置，请通过安全渠道转达');
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : '重置失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <TableRow>
      <TableCell className="align-top">
        <div className="flex flex-col gap-0.5">
          <span className="flex items-center gap-2 text-sm font-medium">
            {member.name}
            {isSelf ? (
              <Badge variant="muted" className="text-[10px]">
                你
              </Badge>
            ) : null}
            {member.isPlatformAdmin ? (
              <Badge variant="secondary" className="text-[10px]">
                平台管理员
              </Badge>
            ) : null}
            {member.deactivatedAt ? (
              <Badge variant="destructive" className="text-[10px]">
                已暂停
              </Badge>
            ) : null}
          </span>
          <span className="text-muted-foreground font-mono text-xs">{member.email}</span>
        </div>
      </TableCell>
      <TableCell className="align-top">
        {mayTouch ? (
          <Select value={member.role} onValueChange={changeRole} disabled={busy}>
            <SelectTrigger size="sm" className="w-40" aria-label={`${member.email} 的组织角色`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[...new Set([member.role, ...grantable])].map((role) => (
                <SelectItem key={role} value={role}>
                  {ORG_ROLE_LABEL[role] ?? role}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <Badge variant="muted" className="font-mono text-[10px]">
            {ORG_ROLE_LABEL[member.role] ?? member.role}
          </Badge>
        )}
      </TableCell>
      <TableCell className="align-top">
        <ProjectCell member={member} me={me} projects={projects} onChanged={onChanged} />
      </TableCell>
      <TableCell className="text-muted-foreground align-top text-xs">{timeAgo(member.lastLoginAt)}</TableCell>
      {canManage ? (
        <TableCell className="text-right align-top">
          {mayTouch ? (
            <div className="flex justify-end gap-1">
              <Button
                variant="ghost"
                size="icon"
                aria-label={member.deactivatedAt ? '恢复账号' : '暂停账号'}
                onClick={toggleSuspend}
                disabled={busy}
              >
                {member.deactivatedAt ? <RotateCcw /> : <Ban className="text-destructive" />}
              </Button>
              <Button variant="ghost" size="icon" aria-label="重置密码" onClick={resetPassword} disabled={busy}>
                <KeyRound />
              </Button>
              <Button variant="ghost" size="icon" aria-label="移出组织" onClick={remove} disabled={busy}>
                <Trash2 className="text-destructive" />
              </Button>
            </div>
          ) : null}
        </TableCell>
      ) : null}
    </TableRow>
  );
}

/**
 * Project assignments, edited in place.
 *
 * A role select plus a remove button per assignment; `?` is not used for admin UI.
 */
function ProjectCell({
  member,
  me,
  projects,
  onChanged,
}: {
  member: Member;
  me: Me | null | undefined;
  projects: ProjectSummary[];
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [projectId, setProjectId] = useState<string>('');
  const [role, setRole] = useState<string>('DEVELOPER');
  const [busy, setBusy] = useState(false);

  const canManageProjects =
    Boolean(me?.isPlatformAdmin) || me?.role === 'ORG_OWNER' || me?.role === 'ORG_ADMIN' || me?.role === 'PROJECT_MANAGER';

  async function assign() {
    if (!projectId) return;
    setBusy(true);
    try {
      await put(`/organization/members/${member.userId}/projects/${projectId}`, { role });
      toast.success('项目角色已保存');
      setEditing(false);
      onChanged();
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : '保存失败');
    } finally {
      setBusy(false);
    }
  }

  async function unassign(id: string) {
    setBusy(true);
    try {
      await del(`/organization/members/${member.userId}/projects/${id}`);
      toast.success('已移除项目角色');
      onChanged();
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : '移除失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex max-w-64 flex-col gap-1">
      {member.projects.map((project) => (
        <span key={project.projectId} className="flex items-center gap-1 text-xs">
          <span className="truncate">{project.projectName}</span>
          <Badge variant="muted" className="font-mono text-[10px]">
            {PROJECT_ROLE_LABEL[project.role] ?? project.role}
          </Badge>
          {project.localeScope.length ? (
            <span className="text-muted-foreground font-mono text-[10px]">{project.localeScope.join(' ')}</span>
          ) : null}
          {canManageProjects ? (
            <Button
              variant="ghost"
              size="icon"
              className="size-5"
              aria-label={`移除 ${project.projectName} 的项目角色`}
              onClick={() => unassign(project.projectId)}
              disabled={busy}
            >
              <Trash2 className="size-3" />
            </Button>
          ) : null}
        </span>
      ))}

      {canManageProjects ? (
        editing ? (
          <div className="flex flex-wrap items-center gap-1">
            <Select value={projectId} onValueChange={setProjectId}>
              <SelectTrigger size="sm" className="h-7 w-32" aria-label="项目">
                <SelectValue placeholder="项目" />
              </SelectTrigger>
              <SelectContent>
                {projects.map((project) => (
                  <SelectItem key={project.id} value={project.id}>
                    {project.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={role} onValueChange={setRole}>
              <SelectTrigger size="sm" className="h-7 w-28" aria-label="项目角色">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(PROJECT_ROLE_LABEL).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button size="sm" className="h-7" onClick={assign} disabled={busy || !projectId}>
              {busy ? <Spinner data-icon="inline-start" /> : <Save data-icon="inline-start" />}
              保存
            </Button>
            <Button size="sm" variant="ghost" className="h-7" onClick={() => setEditing(false)} disabled={busy}>
              取消
            </Button>
          </div>
        ) : (
          <Button variant="ghost" size="sm" className="h-7 w-fit px-2" onClick={() => setEditing(true)}>
            <Plus data-icon="inline-start" />
            项目角色
          </Button>
        )
      ) : null}
    </div>
  );
}

function AddMemberCard({ grantable, onAdded }: { grantable: string[]; onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('DEVELOPER');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const roles = grantable.length ? grantable : ['READONLY'];

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      // Name and password are only needed for a brand-new account; an address that already has an
      // account on this platform is attached to the organization without touching its password.
      await post('/organization/members', {
        email,
        role,
        ...(name ? { name } : {}),
        ...(password ? { password } : {}),
      });
      toast.success(`已添加 ${email}`);
      setOpen(false);
      setEmail('');
      setName('');
      setPassword('');
      setRole('DEVELOPER');
      onAdded();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <UserPlus className="size-4" />
          新建成员
        </CardTitle>
        <CardDescription>
          直接创建账号并设置初始密码，再把邮箱与密码通过安全渠道交给本人。平台不发送邀请邮件，也不开放自助注册。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button className="w-full">
              <Plus data-icon="inline-start" />
              创建账号
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>新建成员</DialogTitle>
              <DialogDescription>
                邮箱已在本平台注册过时，会直接挂到本组织，不会修改对方密码——需要重置请用列表里的钥匙按钮。
              </DialogDescription>
            </DialogHeader>

            <ErrorAlert error={error} onDismiss={() => setError(null)} />

            <FieldGroup className="gap-4">
              <Field>
                <FieldLabel htmlFor="member-email">邮箱</FieldLabel>
                <Input
                  id="member-email"
                  type="email"
                  autoComplete="off"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="teammate@example.com"
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="member-name">姓名（新账号必填）</FieldLabel>
                <Input id="member-name" value={name} onChange={(event) => setName(event.target.value)} />
              </Field>
              <Field>
                <FieldLabel htmlFor="member-password">初始密码（新账号必填，至少 10 位）</FieldLabel>
                <Input
                  id="member-password"
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
                <FieldDescription>只用于新建账号；已存在的账号不会被改密码。</FieldDescription>
              </Field>
              <Field>
                <FieldLabel>组织角色</FieldLabel>
                <Select value={role} onValueChange={setRole}>
                  <SelectTrigger className="w-full" aria-label="组织角色">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {roles.map((value) => (
                      <SelectItem key={value} value={value}>
                        {ORG_ROLE_LABEL[value] ?? value}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FieldDescription>{ORG_ROLE_HINT[role] ?? ''}</FieldDescription>
              </Field>
            </FieldGroup>

            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
                取消
              </Button>
              <Button onClick={submit} disabled={busy || !email}>
                {busy ? <Spinner data-icon="inline-start" /> : <Plus data-icon="inline-start" />}
                创建
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}

function RoleLegend() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldCheck className="size-4" />
          角色说明
        </CardTitle>
        <CardDescription>组织角色是上限；项目角色只能在这个上限内细分</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {Object.entries(ORG_ROLE_LABEL).map(([role, label], index) => (
          <div key={role} className="flex flex-col gap-0.5">
            {index > 0 ? <Separator className="my-1" /> : null}
            <span className="text-sm font-medium">{label}</span>
            <span className="text-muted-foreground text-xs">{ORG_ROLE_HINT[role]}</span>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
