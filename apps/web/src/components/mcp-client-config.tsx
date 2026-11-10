'use client';

import Link from 'next/link';
import { KeyRound, Plug, Terminal, TerminalSquare } from 'lucide-react';

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
  remote: string;
  claudeCli: string;
}

/**
 * Client configuration cards, shared by `/mcp` and `/developers/tokens`.
 *
 * Both pages are places a developer looks for "how do I connect", and two hand-maintained copies
 * of the same instructions is how they end up disagreeing. `showTokenStep` is false on the
 * developer page, which is already about issuing tokens.
 *
 * There is one MCP — the platform's — so there is one MCP card. Local repository work is the
 * CLI's job, and it is described as such rather than dressed up as an MCP server.
 *
 * `error` is the fetch's error, if the caller has one to report. Without it a failed request is
 * indistinguishable from a slow one: the caller's page keeps showing the loading shape forever and
 * the reason never reaches the screen. Callers that already surface the same error at page level
 * (so it also shows on their other tabs) can leave it out.
 */
export function McpClientConfig({
  snippets,
  showTokenStep = true,
  error,
}: {
  snippets: McpClientSnippets | undefined;
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
            Remote MCP（平台侧）
          </CardTitle>
          <CardDescription>
            只暴露平台数据，没有任何本地文件能力。可配在任何机器上，只需要 URL 加 Token；不需要在仓库里装任何东西。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <CodeBlock code={snippets.remote} what="MCP 配置（.mcp.json）" />
          <div className="flex flex-col gap-2">
            <span className="text-muted-foreground text-xs">或者用 Claude Code 命令直接添加：</span>
            <CodeBlock code={snippets.claudeCli} what="Claude Code 命令" language="bash" />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <TerminalSquare className="size-4" />
            本地仓库操作（CLI，不是 MCP）
          </CardTitle>
          <CardDescription>
            平台不提供本地 MCP：它够不到你的磁盘，也不该够到。需要扫描、比较或写回文件时在仓库里运行 CLI， 它受{' '}
            <span className="font-mono">.localehub/config.yaml</span> 的 workspace 白名单约束，写回前有备份与原子写。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <CodeBlock
            code={[
              'localehub scan                  # 扫描语言文件并规范化',
              'localehub sync preview          # 与平台三方比较，只读',
              'localehub sync push --confirm   # 推送本地变更',
              'localehub apply preview         # 回写 dry-run',
              'localehub apply --confirm       # 原子写回 + 备份',
              'localehub patch                 # 生成 patch，不 commit',
            ].join('\n')}
            what="本地同步命令"
            language="bash"
          />
          <Alert variant="warning">
            <Terminal />
            <AlertTitle>Agent 也能跑这些命令</AlertTitle>
            <AlertDescription>
              Claude Code / Cursor 可以自己读写你的文件；需要平台的三方比较、冲突检测与基线记录时， 让它用 Bash
              调上面的命令，而不是绕过它们直接改译文——直接改会丢掉冲突检测。
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
