'use client';

import Link from 'next/link';
import { Boxes, Info, Languages, Plug, ScrollText, Sparkles } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { McpClientConfig, type McpClientSnippets } from '@/components/mcp-client-config';
import { EmptyState } from '@/components/empty-state';
import { ErrorAlert } from '@/components/error-alert';
import { PageHeader } from '@/components/page-header';
import { StatusBadge } from '@/components/status-badge';
import { useAsync } from '@/components/use-async';
import { get } from '@/lib/api';

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

      <Tabs defaultValue="remote">
        {/* The registry's TabsList is `inline-flex w-fit`, so it keeps its content width when the
            viewport shrinks — four tabs then push the page 200px wide on a phone. Let it scroll
            instead of reflowing, and leave the vendored component untouched. */}
        <TabsList className="max-w-full justify-start overflow-x-auto">
          <TabsTrigger value="remote">Remote MCP {data ? `(${data.remote.length})` : ''}</TabsTrigger>
          <TabsTrigger value="config">客户端配置</TabsTrigger>
          <TabsTrigger value="resources">Resources & Prompts</TabsTrigger>
          <TabsTrigger value="skills">Skills {skills ? `(${skills.length})` : ''}</TabsTrigger>
        </TabsList>

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
