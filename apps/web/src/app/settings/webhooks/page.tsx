'use client';

import { useState } from 'react';
import { AlertTriangle, Plus, RefreshCw, Trash2, Webhook } from 'lucide-react';
import { toast } from 'sonner';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
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
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { CodeBlock } from '@/components/code-block';
import { ErrorAlert } from '@/components/error-alert';
import { PageHeader } from '@/components/page-header';
import { StatusBadge } from '@/components/status-badge';
import { timeAgo, useAsync } from '@/components/use-async';
import { del, get, patch, post, type Me } from '@/lib/api';

/**
 * Webhook endpoints.
 *
 * The signing secret is shown exactly once, in the dialog that created it, with the verification
 * snippet next to it — the moment somebody needs that code is the moment they can no longer fetch
 * the secret, so putting it on a separate docs page would be a worse place for it.
 */

const EVENT_TYPES = [
  'SYNC_PUSHED',
  'TRANSLATION_APPROVED',
  'TRANSLATION_REJECTED',
  'TRANSLATION_SUBMITTED',
  'TRANSLATION_STALE',
  'KEY_CREATED',
  'KEY_ARCHIVED',
  'SYNC_APPLIED',
  'CONFLICT_RESOLVED',
  'RELEASE_PUBLISHED',
] as const;

interface WebhookRow {
  id: string;
  url: string;
  eventTypes: string[];
  secretPrefix: string;
  active: boolean;
  description: string | null;
  createdAt: string;
  deliveries: Record<string, number>;
}

interface DeliveryRow {
  id: string;
  eventId: string;
  eventType: string;
  status: string;
  attempts: number;
  lastStatusCode: number | null;
  lastError: string | null;
  nextAttemptAt: string | null;
  deliveredAt: string | null;
  createdAt: string;
}

export default function WebhooksPage() {
  const { data: me } = useAsync(() => get<Me>('/auth/me'), []);
  const { data: hooks, error, loading, reload } = useAsync(() => get<WebhookRow[]>('/organization/webhooks'), []);
  const [expanded, setExpanded] = useState<string | null>(null);

  const canManage = me ? me.isPlatformAdmin || me.role === 'ORG_OWNER' || me.role === 'ORG_ADMIN' : null;

  return (
    <>
      <PageHeader title="Webhook" description="把平台事件推送到你自己的服务；投递带 HMAC 签名，失败会退避重试" />

      <ErrorAlert error={error} />

      {canManage === false ? (
        <Alert variant="info">
          <AlertTriangle />
          <AlertTitle>无权管理</AlertTitle>
          <AlertDescription>Webhook 会把译文内容发到调用方指定的地址，因此只有组织所有者 / 管理员可以配置。</AlertDescription>
        </Alert>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
          <Card className="min-w-0">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Webhook className="size-4" />
                端点 {hooks ? `(${hooks.length})` : ''}
              </CardTitle>
              <CardDescription>没有勾选事件类型的端点接收全部事件</CardDescription>
            </CardHeader>
            <CardContent>
              {loading ? (
                <Skeleton className="h-40" />
              ) : hooks?.length ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>地址</TableHead>
                      <TableHead>事件</TableHead>
                      <TableHead>投递</TableHead>
                      <TableHead>启用</TableHead>
                      <TableHead className="text-right">操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {hooks.map((hook) => (
                      <>
                        <TableRow key={hook.id}>
                          <TableCell className="align-top">
                            <div className="flex max-w-72 flex-col gap-0.5">
                              <span className="truncate font-mono text-xs">{hook.url}</span>
                              {hook.description ? (
                                <span className="text-muted-foreground text-xs">{hook.description}</span>
                              ) : null}
                              <span className="text-muted-foreground font-mono text-[10px]">{hook.secretPrefix}…</span>
                            </div>
                          </TableCell>
                          <TableCell className="align-top">
                            {hook.eventTypes.length ? (
                              <div className="flex max-w-56 flex-wrap gap-1">
                                {hook.eventTypes.map((type) => (
                                  <Badge key={type} variant="muted" className="font-mono text-[10px]">
                                    {type}
                                  </Badge>
                                ))}
                              </div>
                            ) : (
                              <Badge variant="secondary" className="text-[10px]">
                                全部事件
                              </Badge>
                            )}
                          </TableCell>
                          <TableCell className="align-top text-xs">
                            <div className="flex flex-col gap-0.5">
                              <span>成功 {hook.deliveries.DELIVERED ?? 0}</span>
                              {(hook.deliveries.PENDING ?? 0) > 0 ? (
                                <span className="text-muted-foreground">重试中 {hook.deliveries.PENDING}</span>
                              ) : null}
                              {(hook.deliveries.FAILED ?? 0) > 0 ? (
                                <span className="text-destructive">失败 {hook.deliveries.FAILED}</span>
                              ) : null}
                            </div>
                          </TableCell>
                          <TableCell className="align-top">
                            <Switch
                              checked={hook.active}
                              aria-label={`${hook.url} 启用`}
                              onCheckedChange={async (checked) => {
                                try {
                                  await patch(`/organization/webhooks/${hook.id}`, { active: checked });
                                  toast.success(checked ? '已启用' : '已停用');
                                  reload();
                                } catch (caught) {
                                  toast.error(caught instanceof Error ? caught.message : '保存失败');
                                }
                              }}
                            />
                          </TableCell>
                          <TableCell className="text-right align-top">
                            <div className="flex justify-end gap-1">
                              <Button
                                variant="ghost"
                                size="icon"
                                aria-label="投递记录"
                                onClick={() => setExpanded(expanded === hook.id ? null : hook.id)}
                              >
                                <RefreshCw />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                aria-label="删除"
                                onClick={async () => {
                                  if (!window.confirm(`删除 ${hook.url}？投递记录会一并删除。`)) return;
                                  try {
                                    await del(`/organization/webhooks/${hook.id}`);
                                    toast.success('已删除');
                                    reload();
                                  } catch (caught) {
                                    toast.error(caught instanceof Error ? caught.message : '删除失败');
                                  }
                                }}
                              >
                                <Trash2 className="text-destructive" />
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                        {expanded === hook.id ? (
                          <TableRow key={`${hook.id}-deliveries`}>
                            <TableCell colSpan={5} className="bg-muted/30">
                              <DeliveryList webhookId={hook.id} />
                            </TableCell>
                          </TableRow>
                        ) : null}
                      </>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <EmptyState icon={<Webhook />} title="还没有端点" description="用右侧的表单添加一个。" />
              )}
            </CardContent>
          </Card>

          {canManage ? <AddWebhookCard onAdded={reload} /> : null}
        </div>
      )}
    </>
  );
}

function DeliveryList({ webhookId }: { webhookId: string }) {
  const { data, error, loading } = useAsync(
    () => get<DeliveryRow[]>(`/organization/webhooks/${webhookId}/deliveries?limit=25`),
    [webhookId],
  );
  if (loading) return <Skeleton className="h-16" />;
  if (error) return <ErrorAlert error={error} />;
  if (!data?.length) return <p className="text-muted-foreground text-xs">还没有投递记录。</p>;
  return (
    <div className="flex flex-col gap-1">
      {data.map((row) => (
        <div key={row.id} className="flex flex-wrap items-center gap-2 text-xs">
          <StatusBadge status={row.status === 'DELIVERED' ? 'ACTIVE' : row.status} />
          <span className="font-mono text-[10px]">{row.eventType}</span>
          <span className="text-muted-foreground font-mono text-[10px]">{row.eventId}</span>
          <span className="text-muted-foreground">尝试 {row.attempts} 次</span>
          {row.lastStatusCode ? <span className="text-muted-foreground">HTTP {row.lastStatusCode}</span> : null}
          {row.lastError ? <span className="text-destructive truncate">{row.lastError}</span> : null}
          <span className="text-muted-foreground ml-auto">{timeAgo(row.createdAt)}</span>
        </div>
      ))}
    </div>
  );
}

function AddWebhookCard({ onAdded }: { onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [description, setDescription] = useState('');
  const [eventTypes, setEventTypes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [secret, setSecret] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const created = await post<{ secret: string }>('/organization/webhooks', {
        url,
        eventTypes,
        ...(description ? { description } : {}),
      });
      setSecret(created.secret);
      setUrl('');
      setDescription('');
      setEventTypes([]);
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
          <Plus className="size-4" />
          添加端点
        </CardTitle>
        <CardDescription>签名密钥只在创建时显示一次，请立即保存。</CardDescription>
      </CardHeader>
      <CardContent>
        <Dialog
          open={open}
          onOpenChange={(next) => {
            setOpen(next);
            if (!next) setSecret(null);
          }}
        >
          <DialogTrigger asChild>
            <Button className="w-full">
              <Plus data-icon="inline-start" />
              新建 Webhook
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>{secret ? '保存签名密钥' : '新建 Webhook'}</DialogTitle>
              <DialogDescription>
                {secret
                  ? '这段密钥不会再显示。用它验证 x-localehub-signature 头。'
                  : '地址必须能被平台访问；不接受 file:// 之类的协议，也不接受把凭据写进 URL。'}
              </DialogDescription>
            </DialogHeader>

            {secret ? (
              <div className="flex flex-col gap-3">
                <CodeBlock code={secret} what="签名密钥（只显示这一次）" />
                <CodeBlock
                  language="bash"
                  what="验签（Node.js 伪代码）"
                  code={[
                    "const [t, v1] = header.split(',').map((p) => p.split('=')[1]);",
                    "const expected = createHmac('sha256', secret)",
                    '  .update(`${t}.${rawBody}`)   // 原始请求体，不是重新序列化的',
                    "  .digest('hex');",
                    'timingSafeEqual(Buffer.from(expected), Buffer.from(v1));',
                    '// 再拒绝 |now - t| > 300 的请求，并按 x-localehub-event-id 去重。',
                  ].join('\n')}
                />
              </div>
            ) : (
              <>
                <ErrorAlert error={error} onDismiss={() => setError(null)} />
                <FieldGroup className="gap-4">
                  <Field>
                    <FieldLabel htmlFor="webhook-url">地址</FieldLabel>
                    <Input
                      id="webhook-url"
                      value={url}
                      onChange={(event) => setUrl(event.target.value)}
                      placeholder="https://example.com/localehub/hook"
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="webhook-description">备注（可选）</FieldLabel>
                    <Input
                      id="webhook-description"
                      value={description}
                      onChange={(event) => setDescription(event.target.value)}
                    />
                  </Field>
                  <FieldSet>
                    <FieldLegend variant="label">事件类型</FieldLegend>
                    <FieldDescription>全不勾选表示接收全部事件</FieldDescription>
                    <ScrollArea className="mt-2 h-48 rounded-md border p-3">
                      <FieldGroup className="gap-3">
                        {EVENT_TYPES.map((type) => (
                          <Field key={type} orientation="horizontal">
                            <Checkbox
                              id={`event-${type}`}
                              checked={eventTypes.includes(type)}
                              onCheckedChange={(checked) =>
                                setEventTypes(checked ? [...eventTypes, type] : eventTypes.filter((item) => item !== type))
                              }
                            />
                            <FieldLabel htmlFor={`event-${type}`} className="font-mono text-xs font-normal">
                              {type}
                            </FieldLabel>
                          </Field>
                        ))}
                      </FieldGroup>
                    </ScrollArea>
                  </FieldSet>
                </FieldGroup>
              </>
            )}

            <DialogFooter>
              {secret ? (
                <Button onClick={() => setOpen(false)}>我已保存</Button>
              ) : (
                <>
                  <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
                    取消
                  </Button>
                  <Button onClick={submit} disabled={busy || !url}>
                    {busy ? <Spinner data-icon="inline-start" /> : <Plus data-icon="inline-start" />}
                    创建
                  </Button>
                </>
              )}
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}
