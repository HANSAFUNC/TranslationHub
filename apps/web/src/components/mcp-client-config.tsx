'use client';

import Link from 'next/link';
import { GitBranch, KeyRound, Plug, Terminal } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { CodeBlock } from '@/components/code-block';
import { ErrorAlert } from '@/components/error-alert';

/**
 * Snippets as the API renders them (`GET /api/v1/mcp/tools` → `snippets`).
 *
 * Generated server-side by `@localehub/contracts`, so the web app never composes a connection
 * string itself — the address a client needs is a deployment fact the browser cannot know.
 */
export interface McpClientSnippets {
  remoteOnly: string;
  localAndRemote: string;
  claudeCli: string;
}

/**
 * Client configuration cards, shared by `/mcp` and `/developers/tokens`.
 *
 * Both pages are places a developer looks for "how do I connect", and two hand-maintained copies
 * of the same instructions is how they end up disagreeing. `showTokenStep` is false on the
 * developer page, which is already about issuing tokens.
 *
 * `error` is the fetch's error, if the caller has one to report. Without it a failed request is
 * indistinguishable from a slow one: the caller's page keeps showing the loading shape forever and
 * the reason never reaches the screen. Callers that already surface the same error at page level
 * (so it also shows on their other tabs) can leave it out.
 */
export function McpClientConfig({
  snippets,
  remoteUrl,
  showTokenStep = true,
  error,
}: {
  snippets: McpClientSnippets | undefined;
  remoteUrl: string;
  showTokenStep?: boolean;
  error?: unknown;
}) {
  if (!snippets) return error ? <ErrorAlert error={error} /> : <SnippetSkeleton />;

  return (
    <div className="flex flex-col gap-4">
      {showTokenStep ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <KeyRound className="size-4" />
              第一步：签发 Token
            </CardTitle>
            <CardDescription>所有 MCP 连接都需要令牌。Token 明文只显示一次，之后只能重新签发。</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            <Button asChild>
              <Link href="/developers/tokens">
                <KeyRound data-icon="inline-start" />
                去签发 Token
              </Link>
            </Button>
            <span className="text-muted-foreground self-center text-xs">
              只读场景给 <span className="font-mono">project.read · translation.read · glossary.read</span>； 让 Agent 写草稿再加{' '}
              <span className="font-mono">translation.write</span>。
            </span>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Plug className="size-4" />
            Remote MCP（平台侧，无需本地仓库）
          </CardTitle>
          <CardDescription>只暴露平台数据，不提供任何本地文件能力。可配在任何机器上，只需要 URL 加 Token。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <CodeBlock code={snippets.remoteOnly} what="Remote MCP 配置" />
          <div className="flex flex-col gap-2">
            <span className="text-muted-foreground text-xs">或者用 Claude Code 命令直接添加：</span>
            <CodeBlock code={snippets.claudeCli} what="Claude Code 命令" language="bash" />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <GitBranch className="size-4" />
            Local MCP + Remote MCP（在仓库里两个都用）
          </CardTitle>
          <CardDescription>
            Local MCP 通过 stdio 在开发者机器上运行，文件访问受 workspace 白名单约束。把下面的内容存成仓库根目录的{' '}
            <span className="font-mono">.mcp.json</span>。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <CodeBlock code={snippets.localAndRemote} what="完整 MCP 配置" />
          <Alert variant="warning">
            <Terminal />
            <AlertTitle>把 Local MCP 的路径换成你自己的</AlertTitle>
            <AlertDescription>
              <span className="font-mono text-xs">&lt;path-to-localehub&gt;</span> 要指向这个项目的检出目录； 也可以直接运行{' '}
              <span className="font-mono text-xs">node apps/cli/dist/bin.js mcp-config --remote {remoteUrl}</span>{' '}
              生成填好真实路径的版本。
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    </div>
  );
}

/** Placeholder with the same shape as the cards, so the page does not jump when they arrive. */
function SnippetSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">正在加载客户端配置…</CardTitle>
          <CardDescription>地址由服务端按当前部署生成。</CardDescription>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-48" />
        </CardContent>
      </Card>
    </div>
  );
}
