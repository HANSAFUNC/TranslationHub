# @localehub/web

Next.js 15 + **shadcn/ui** 管理后台。浏览器通过 `NEXT_PUBLIC_API_BASE_URL` 直连 API
（未配置时回退到同源 `/api/v1`，适配 nginx 反向代理），使用与 CLI / MCP 相同的 Bearer Token
鉴权路径，因此 UI 不会绕过任何权限校验。

## 技术栈

| 项 | 选择 |
|---|---|
| 样式 | Tailwind CSS v4（CSS-first，`@theme inline` + CSS 变量） |
| 组件 | shadcn/ui（style `new-york`，base `radix`，icon `lucide`） |
| 令牌 | `src/app/globals.css` 的 `:root` / `.dark`；业务代码只用语义色 |
| 主题 | `ThemeProvider`（light / dark / system，localStorage 持久化 + 首屏内联脚本防闪烁） |
| 提示 | `sonner`（Radix 项目规范） |

## 目录

```text
src/
├── app/                     15 条路由
├── components/
│   ├── ui/                  shadcn/ui 注册表组件（保持与上游一致）
│   ├── app-shell.tsx        侧边栏 + 顶栏 + 移动端 Sheet 导航
│   ├── theme-provider.tsx   主题上下文
│   ├── status-badge.tsx     领域状态 → Badge 变体映射
│   ├── empty-state.tsx      基于官方 Empty 组合的薄封装
│   ├── error-alert.tsx      LocaleHubError → Alert
│   ├── page-header.tsx / stat-card.tsx
│   └── use-async.ts         数据加载 hook + 时间格式化
└── lib/{api.ts,utils.ts}
```

## 维护 shadcn 组件

```bash
cd apps/web
npx shadcn@latest add <component> --dry-run     # 先看会改哪些文件
npx shadcn@latest add <component> --diff <file> # 对比本地与上游
npx shadcn@latest docs <component>              # 取官方文档与示例
```

`components/ui/**` 视为 vendored 源码：ESLint 对该目录关闭了项目自定义的严格规则，以保持与上游
逐字节一致（这样 `--diff` 永远是干净的）。业务代码的规则不放松。

```bash
pnpm --filter @localehub/web dev      # :3000
pnpm --filter @localehub/web build
```

## 页面

| 路径 | 内容 |
|---|---|
| `/login` | 登录 / 首次部署初始化 |
| `/` | 工作台：项目、Key、条目、待审核、冲突、最近同步 |
| `/projects` | 项目列表与新建 |
| `/projects/[id]` | 项目概览：语言、平台、仓库连接、状态分布 |
| `/projects/[id]/translations` | 翻译编辑器：原文/译文并排、上下文、版本历史、QA、草稿与审核 |
| `/projects/[id]/sync` | 仓库连接、心跳、文件映射、同步历史、冲突入口、CLI 操作说明 |
| `/translations`、`/review`、`/qa` | 全局入口（选择项目后进入） |
| `/sync`、`/sync/sessions`、`/sync/conflicts` | 同步总览、历史会话、三栏冲突处理 |
| `/developers/tokens` | API / MCP Token 签发与撤销、`.mcp.json` 示例 |
| `/mcp` | Local / Remote MCP 工具清单（含 JSON Schema）与 Skill 列表 |
| `/settings/organization` | 账号、组织、权限模型说明 |

仓库同步页**不会**伪造平台能直接访问开发者机器：所有 scan/push/pull/apply 都明确说明需要
在本地由 CLI 执行。
