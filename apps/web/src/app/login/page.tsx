'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Languages } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { ErrorAlert } from '@/components/error-alert';
import { post } from '@/lib/api';

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('demo@localehub.dev');
  const [password, setPassword] = useState('demo-password-123');
  const [organizationName, setOrganizationName] = useState('Demo Organization');
  const [name, setName] = useState('Demo Admin');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // Both endpoints set the HttpOnly session cookie (and the CSRF cookie) themselves; there is
      // no token for the page to keep.
      await (mode === 'login'
        ? post('/auth/login', { email, password })
        : post('/auth/register', { email, password, name, organizationName }));
      toast.success(mode === 'login' ? '已登录' : '管理员账号已创建');
      router.replace('/');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bg-muted/40 flex min-h-svh items-center justify-center p-4">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <div className="flex flex-col items-center gap-2 text-center">
          <div className="bg-primary text-primary-foreground flex size-10 items-center justify-center rounded-xl">
            <Languages />
          </div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">LocaleHub</h1>
            <p className="text-muted-foreground text-sm">本地化双向同步 · 代码仓库 ↔ 平台</p>
          </div>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>{mode === 'login' ? '登录' : '初始化实例'}</CardTitle>
            <CardDescription>
              {mode === 'login' ? '使用组织成员账号登录管理后台' : '仅当实例还没有任何用户时开放；之后请由组织管理员邀请成员'}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <ErrorAlert error={error} onDismiss={() => setError(null)} />
            <form onSubmit={submit}>
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="email">邮箱</FieldLabel>
                  <Input
                    id="email"
                    type="email"
                    autoComplete="username"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    required
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="password">密码</FieldLabel>
                  <Input
                    id="password"
                    type="password"
                    autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    required
                  />
                </Field>
                {mode === 'register' ? (
                  <>
                    <Field>
                      <FieldLabel htmlFor="name">姓名</FieldLabel>
                      <Input id="name" value={name} onChange={(event) => setName(event.target.value)} required />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="org">组织名称</FieldLabel>
                      <Input
                        id="org"
                        value={organizationName}
                        onChange={(event) => setOrganizationName(event.target.value)}
                        required
                      />
                    </Field>
                  </>
                ) : null}
                <Field>
                  <Button type="submit" disabled={busy}>
                    {busy ? <Spinner data-icon="inline-start" /> : null}
                    {mode === 'login' ? '登录' : '创建管理员'}
                  </Button>
                  {mode === 'login' ? (
                    <FieldDescription>
                      默认演示账号 <span className="font-mono">demo@localehub.dev / demo-password-123</span>
                    </FieldDescription>
                  ) : null}
                </Field>
              </FieldGroup>
            </form>

            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="w-full"
              onClick={() => {
                setMode(mode === 'login' ? 'register' : 'login');
                setError(null);
              }}
            >
              {mode === 'login' ? '首次部署？初始化实例' : '返回登录'}
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
