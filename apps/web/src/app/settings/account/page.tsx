'use client';

import { useState } from 'react';
import { KeyRound, ShieldCheck, UserRound } from 'lucide-react';
import { toast } from 'sonner';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { ErrorAlert } from '@/components/error-alert';
import { PageHeader } from '@/components/page-header';
import { useAsync } from '@/components/use-async';
import { patch, get, type Me } from '@/lib/api';

/**
 * Your own account.
 *
 * Changing your own password exists because nothing else did: an organization admin can reset
 * someone else's, but that route refuses to act on yourself, and there is no email channel to
 * fall back on. Without this page a person's only way to rotate their password was to ask a
 * colleague to set it for them.
 */
export default function AccountPage() {
  const { data: me, error, loading } = useAsync(() => get<Me>('/auth/me'), []);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<unknown>(null);

  const mismatch = confirm.length > 0 && newPassword !== confirm;
  const tooShort = newPassword.length > 0 && newPassword.length < 10;

  async function submit() {
    setBusy(true);
    setFormError(null);
    try {
      await patch('/auth/password', { currentPassword, newPassword });
      toast.success('密码已更新');
      setCurrentPassword('');
      setNewPassword('');
      setConfirm('');
    } catch (caught) {
      setFormError(caught);
    } finally {
      setBusy(false);
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
      <PageHeader title="账号与密码" description="你自己的账号信息与凭据" />
      <ErrorAlert error={error} />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <UserRound className="size-4" />
              账号
            </CardTitle>
            <CardDescription>邮箱与角色由组织管理员维护</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="flex flex-col gap-0.5">
              <span className="text-sm font-medium">{me?.name}</span>
              <span className="text-muted-foreground font-mono text-xs">{me?.email}</span>
            </div>
            <Separator />
            <div className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">当前组织角色</span>
              <Badge variant="muted" className="font-mono text-[10px]">
                {me?.role ?? '—'}
              </Badge>
              {me?.isPlatformAdmin ? (
                <Badge variant="secondary" className="text-[10px]">
                  平台管理员
                </Badge>
              ) : null}
            </div>
            <p className="text-muted-foreground text-xs">需要改邮箱或角色，请让组织管理员在「组织成员」页处理。</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <KeyRound className="size-4" />
              修改密码
            </CardTitle>
            <CardDescription>至少 10 位。修改后请用新密码重新登录其他设备。</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <ErrorAlert error={formError} onDismiss={() => setFormError(null)} />
            <FieldGroup className="gap-4">
              <Field>
                <FieldLabel htmlFor="current-password">当前密码</FieldLabel>
                <Input
                  id="current-password"
                  type="password"
                  autoComplete="current-password"
                  value={currentPassword}
                  onChange={(event) => setCurrentPassword(event.target.value)}
                />
              </Field>
              <Field data-invalid={tooShort || undefined}>
                <FieldLabel htmlFor="new-password">新密码</FieldLabel>
                <Input
                  id="new-password"
                  type="password"
                  autoComplete="new-password"
                  aria-invalid={tooShort || undefined}
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                />
                {tooShort ? <FieldDescription>至少 10 位。</FieldDescription> : null}
              </Field>
              <Field data-invalid={mismatch || undefined}>
                <FieldLabel htmlFor="confirm-password">确认新密码</FieldLabel>
                <Input
                  id="confirm-password"
                  type="password"
                  autoComplete="new-password"
                  aria-invalid={mismatch || undefined}
                  value={confirm}
                  onChange={(event) => setConfirm(event.target.value)}
                />
                {mismatch ? <FieldDescription>两次输入不一致。</FieldDescription> : null}
              </Field>
            </FieldGroup>
            <Button className="w-fit" onClick={submit} disabled={busy || !currentPassword || newPassword.length < 10 || mismatch}>
              {busy ? <Spinner data-icon="inline-start" /> : <KeyRound data-icon="inline-start" />}
              更新密码
            </Button>
          </CardContent>
        </Card>
      </div>

      <Alert variant="info" className="mt-4">
        <ShieldCheck />
        <AlertTitle>关于会话</AlertTitle>
        <AlertDescription>
          改密码不会注销已登录的其他设备——平台还没有会话列表，无法逐个撤销。要立刻切断某人的访问，请管理员在
          「组织成员」里暂停该账号，那会让它现有的会话与 MCP Token 立即失效。
        </AlertDescription>
      </Alert>
    </>
  );
}
