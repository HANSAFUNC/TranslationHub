'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { Boxes, Copy, Info, KeyRound, Languages, Plug, ScrollText, Sparkles, Terminal } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { McpClientConfig, type McpClientSnippets } from '@/components/mcp-client-config';
import { CodeBlock } from '@/components/code-block';
import { EmptyState } from '@/components/empty-state';
import { ErrorAlert } from '@/components/error-alert';
import { PageHeader } from '@/components/page-header';
import { StatusBadge } from '@/components/status-badge';
import { useAsync } from '@/components/use-async';
import { get, type Me, type ProjectSummary } from '@/lib/api';
import { toast } from 'sonner';

interface ToolDescriptor {
  name: string;
  server: string;
  description: string;
  inputSchema: { properties?: Record<string, unknown>; required?: string[] } | null;
}

interface McpTools {
  remote: ToolDescriptor[];
  resources: string[];
  prompts: string[];
  /** Externally reachable endpoint, as configured on the server. */
  remoteUrl: string;
  /** How a client reads and invokes skills; the API owns these strings, not the browser. */
  skillDelivery: { indexUri: string; resourceTemplate: string; promptPrefix: string };
  /** Ready-to-paste configs, generated server-side by the same code the CLI uses. */
  snippets: McpClientSnippets;
}

interface Skill {
  slug: string;
  name: string;
  kind: string;
  version: string;
  status: string;
  description: string | null;
  /**
   * What a client can reach this row at, computed by the API with the same function the MCP
   * servers use — `null` when this row is not the one that gets delivered.
   *
   * Deliberately not re-derived here: the browser would have to repeat the version comparison and
   * the status/kind rules, and any disagreement would show as a handle that no server answers.
   */
  mcp: { resourceUri: string; promptName: string | null } | null;
}

/** Why a listed row is not the one a client receives. */
function notDeliveredReason(skill: Skill): string {
  if (skill.status !== 'PUBLISHED') return '未发布，客户端不可见';
  return '被更高版本取代';
}

function ToolTable({ tools, loading }: { tools?: ToolDescriptor[]; loading: boolean }) {
  if (loading) return <Skeleton className="h-48" />;
  if (!tools?.length) return <EmptyState icon={<Plug />} title="没有注册的工具" />;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-64">工具</TableHead>
          <TableHead>说明</TableHead>
          <TableHead>参数</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {tools.map((tool) => (
          <TableRow key={tool.name}>
            <TableCell className="align-top font-mono text-xs">{tool.name}</TableCell>
            <TableCell className="align-top text-sm">{tool.description}</TableCell>
            <TableCell className="text-muted-foreground break-all align-top font-mono text-xs">
              {Object.keys(tool.inputSchema?.properties ?? {}).join(', ') || '—'}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/**
 * The onboarding sequence, in order.
 *
 * Written as steps rather than a reference because the page previously assumed a reader already
 * knew what they needed: it listed the tools, the resources and a config snippet, but never said
 * "sign a token, then find your project id, then paste this, then check it worked". The project id
 * in particular was the step nobody could guess — fourteen of the fifteen tools take it, and it
 * was not visible anywhere in the UI.
 *
 * The example prompts are built from the reader's own projects, so what they copy is already about
 * their work rather than about a demo.
 */
function McpOnboarding({ snippets, remoteUrl }: { snippets?: McpClientSnippets; remoteUrl: string }) {
  const { data: projects } = useAsync(() => get<ProjectSummary[]>('/projects'), []);
  const { data: me } = useAsync(() => get<Me>('/auth/me'), []);
  const first = projects?.[0];
  const projectLabel = first?.name ?? '你的项目';

  return (
    <div className="flex flex-col gap-4">
      <Alert variant="info">
        <Info />
        <AlertTitle>四步接入，全部可在浏览器里完成</AlertTitle>
        <AlertDescription>平台只有一个 Remote MCP，跑在服务端。不需要在仓库里装任何东西，也不需要本地进程。</AlertDescription>
      </Alert>

      <Step
        n={1}
        title="签发一个 Token"
        description="Token 决定 Agent 能做什么。只读场景给 project.read + translation.read + glossary.read；要让 Agent 写草稿再加 translation.write。"
      >
        <Button asChild>
          <Link href="/developers/tokens">
            <KeyRound data-icon="inline-start" />
            去签发 Token
          </Link>
        </Button>
        <p className="text-muted-foreground text-xs">
          明文只显示一次。存进环境变量，别提交到 Git：
          <code className="bg-muted ml-1 rounded px-1 font-mono">export LOCALEHUB_TOKEN=&quot;lh_mcp_…&quot;</code>
        </p>
      </Step>

      <Step
        n={2}
        title="记下你的 project_id"
        description="十五个工具里有十四个把它当第一个参数。它同时是你项目页地址的最后一段。"
      >
        {projects?.length ? (
          <div className="flex flex-col gap-2">
            {projects.slice(0, 5).map((project) => (
              <div key={project.id} className="flex flex-wrap items-center gap-2">
                <Link href={`/projects/${project.id}`} className="text-sm hover:underline">
                  {project.name}
                </Link>
                <CopyableValue value={project.id} label={`复制 ${project.name} 的 project_id`} />
              </div>
            ))}
            {projects.length > 5 ? (
              <span className="text-muted-foreground text-xs">还有 {projects.length - 5} 个，见项目列表。</span>
            ) : null}
          </div>
        ) : (
          <p className="text-muted-foreground text-xs">
            你还没有项目。
            <Link href="/projects" className="ml-1 underline">
              先创建一个
            </Link>
            。
          </p>
        )}
        <p className="text-muted-foreground text-xs">
          也可以让 Agent 自己问：<code className="bg-muted rounded px-1 font-mono">list_projects</code> 只返回你的 Token
          能访问的项目，所以它不会看到别人的。
        </p>
      </Step>

      <Step
        n={3}
        title="把配置放进客户端"
        description="Claude Code / Cursor / Codex 都是这一段。片段里的地址由平台按当前部署生成，不用你填。"
      >
        {snippets ? (
          <div className="flex flex-col gap-3">
            <CodeBlock code={snippets.remote} what="MCP 配置（.mcp.json）" />
            <div className="flex flex-col gap-2">
              <span className="text-muted-foreground text-xs">或者用 Claude Code 命令直接添加：</span>
              <CodeBlock code={snippets.claudeCli} what="Claude Code 命令" language="bash" />
            </div>
          </div>
        ) : (
          <Skeleton className="h-32" />
        )}
      </Step>

      <Step n={4} title="验证，然后开始用" description="重启客户端后，让 Agent 列一下项目。能看到你自己的项目就说明通了。">
        <CodeBlock
          what="对 Agent 说的第一句话"
          language="bash"
          code={`列出 LocaleHub 上我能访问的项目，然后用 ${projectLabel} 的 project_id 读取它的语言列表。`}
        />
        <p className="text-muted-foreground text-xs">接下来可以让它做的事（把 project_id 换成你自己的）：</p>
        <CodeBlock
          what="常用提示词"
          language="bash"
          code={[
            `用 project_id=${first?.id ?? '<project_id>'} 搜索待审核的译文，逐条给出审核建议。`,
            `用 project_id=${first?.id ?? '<project_id>'} 读取 QA 问题，给出修复后的译文并写入草稿。`,
            `用 project_id=${first?.id ?? '<project_id>'} 列出平台已审核的变更，先给我看，不要写任何东西。`,
          ].join('\n')}
        />
        <Alert variant="warning">
          <Terminal />
          <AlertTitle>Agent 只能提建议，不能替你批准</AlertTitle>
          <AlertDescription>
            审核与发布需要人类的 REVIEWER / PROJECT_MANAGER 角色。平台会拒绝 Agent 的批准请求——这是设计，不是缺陷。
          </AlertDescription>
        </Alert>
      </Step>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">还需要什么</CardTitle>
          <CardDescription>上面四步之外的常见问题</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-sm">
          <p>
            <span className="font-medium">读写出你的仓库</span>
            ：MCP 不做这件事，它够不到你的磁盘。用 CLI：
            <code className="bg-muted ml-1 rounded px-1 font-mono text-xs">localehub scan / sync preview / apply --confirm</code>
            ，受 <code className="font-mono text-xs">.localehub/config.yaml</code> 的 workspace 白名单约束。
          </p>
          <p>
            <span className="font-medium">让 Agent 直接调用 Skill</span>
            ：客户端里会出现{' '}
            <code className="bg-muted rounded px-1 font-mono text-xs">/mcp__localehub-remote__skill-&lt;slug&gt;</code>
            ，见「Skills」标签页。
          </p>
          <p className="text-muted-foreground text-xs">
            当前连接地址：<code className="font-mono">{remoteUrl || '—'}</code>
            {me?.organizations.length && me.organizations.length > 1 ? '（Token 决定你能看到哪个组织的数据）' : ''}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function Step({ n, title, description, children }: { n: number; title: string; description: string; children: ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <span className="bg-primary text-primary-foreground flex size-5 items-center justify-center rounded-full text-xs">
            {n}
          </span>
          {title}
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">{children}</CardContent>
    </Card>
  );
}

/** A value with a copy button, for the ids people have to paste somewhere else. */
function CopyableValue({ value, label }: { value: string; label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      className="bg-muted/60 hover:bg-muted flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[11px]"
      onClick={async () => {
        await navigator.clipboard.writeText(value);
        toast.success('已复制');
      }}
    >
      <Copy className="size-3" />
      {value}
    </button>
  );
}

export default function McpPage() {
  const { data, error, loading } = useAsync(() => get<McpTools>('/mcp/tools'), []);
  const { data: skills } = useAsync(() => get<Skill[]>('/skills'), []);

  return (
    <>
      <PageHeader title="MCP 管理" description="平台只暴露一个 Remote MCP（Streamable HTTP）；本地仓库操作由 CLI 完成" />

      <ErrorAlert error={error} />

      <Alert variant="info" className="mb-4">
        <Info />
        <AlertTitle>MCP 边界说明</AlertTitle>
        <AlertDescription>
          平台侧只有一个 Remote MCP，它只提供平台数据，绝不提供{' '}
          <span className="font-mono text-xs">read_local_file / write_local_file</span> 这类任意文件工具。需要读写你的仓库时用
          CLI：
          <span className="font-mono text-xs">localehub scan / sync preview / apply --confirm</span>
          ，它受 <span className="font-mono text-xs">.localehub/config.yaml</span> 的 workspace 白名单约束。
        </AlertDescription>
      </Alert>

      <Tabs defaultValue="guide">
        {/* The registry's TabsList is `inline-flex w-fit`, so it keeps its content width when the
            viewport shrinks — four tabs then push the page 200px wide on a phone. Let it scroll
            instead of reflowing, and leave the vendored component untouched. */}
        <TabsList className="max-w-full justify-start overflow-x-auto">
          <TabsTrigger value="guide">接入教程</TabsTrigger>
          <TabsTrigger value="remote">Remote MCP {data ? `(${data.remote.length})` : ''}</TabsTrigger>
          <TabsTrigger value="config">客户端配置</TabsTrigger>
          <TabsTrigger value="resources">Resources & Prompts</TabsTrigger>
          <TabsTrigger value="skills">Skills {skills ? `(${skills.length})` : ''}</TabsTrigger>
        </TabsList>

        <TabsContent value="guide">
          <McpOnboarding snippets={data?.snippets} remoteUrl={data?.remoteUrl ?? ''} />
        </TabsContent>

        <TabsContent value="remote">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Plug className="size-4" />
                Remote MCP 工具
              </CardTitle>
              <CardDescription>无状态 Streamable HTTP，每个请求自带 Bearer Token</CardDescription>
            </CardHeader>
            <CardContent>
              <ToolTable tools={data?.remote} loading={loading} />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="config">
          <McpClientConfig snippets={data?.snippets} />
        </TabsContent>

        <TabsContent value="resources" className="grid min-w-0 gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Resources</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="flex flex-col gap-1 font-mono text-xs">
                {data?.resources.map((resource) => (
                  <li key={resource} className="bg-muted/50 truncate rounded px-2 py-1">
                    {resource}
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Prompts</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="flex flex-col gap-1 font-mono text-xs">
                {data?.prompts.map((prompt) => (
                  <li key={prompt} className="bg-muted/50 truncate rounded px-2 py-1">
                    {prompt}
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="skills">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Sparkles className="size-4" />
                Skill 注册表
              </CardTitle>
              <CardDescription>
                Skill 通过 MCP 下发给客户端：读 <span className="font-mono text-xs">{data?.skillDelivery.indexUri ?? '…'}</span>{' '}
                取清单，读 <span className="font-mono text-xs">{data?.skillDelivery.resourceTemplate ?? '…'}</span> 取正文。
                不引入新权限；脚本型 Skill 只在隔离环境中运行，从不进入 API 进程。
              </CardDescription>
            </CardHeader>
            <CardContent>
              {skills?.length ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Slug</TableHead>
                      <TableHead>名称</TableHead>
                      <TableHead>类型</TableHead>
                      <TableHead>版本</TableHead>
                      <TableHead>状态</TableHead>
                      <TableHead>客户端可见</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {skills.map((skill) => {
                      const handle = skill.mcp;
                      return (
                        <TableRow key={`${skill.slug}-${skill.version}`}>
                          <TableCell className="font-mono text-xs">{skill.slug}</TableCell>
                          <TableCell className="text-sm">{skill.name}</TableCell>
                          <TableCell>
                            <Badge variant="muted" className="font-mono text-[10px]">
                              {skill.kind}
                            </Badge>
                          </TableCell>
                          <TableCell className="font-mono text-xs">{skill.version}</TableCell>
                          <TableCell>
                            <StatusBadge status={skill.status} />
                          </TableCell>
                          <TableCell className="align-top">
                            {handle ? (
                              <div className="flex flex-col gap-1">
                                <span className="text-muted-foreground break-all font-mono text-[11px]">
                                  {handle.resourceUri}
                                </span>
                                {handle.promptName ? (
                                  <Badge variant="muted" className="w-fit font-mono text-[10px]">
                                    {handle.promptName}
                                  </Badge>
                                ) : (
                                  <span className="text-muted-foreground text-[11px]">只作为 resource，不注册 prompt</span>
                                )}
                              </div>
                            ) : (
                              <span className="text-muted-foreground text-[11px]">{notDeliveredReason(skill)}</span>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              ) : (
                <EmptyState
                  icon={<Sparkles />}
                  title="还没有注册 Skill"
                  description="运行 skills/README.md 里的注册脚本，把内置 Skill 写入平台。"
                />
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle className="text-base">相关页面</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button variant="outline" asChild>
            <Link href="/developers/tokens">
              <Languages data-icon="inline-start" />
              签发 MCP Token
            </Link>
          </Button>
          <Button variant="outline" asChild>
            <Link href="/sync/sessions">
              <ScrollText data-icon="inline-start" />
              同步历史
            </Link>
          </Button>
          <Button variant="outline" asChild>
            <Link href="/projects">
              <Boxes data-icon="inline-start" />
              项目管理
            </Link>
          </Button>
        </CardContent>
      </Card>
    </>
  );
}
