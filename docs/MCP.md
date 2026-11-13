# MCP：平台只暴露一个 Remote MCP

## 1. 为什么只有一个

平台侧**只有一个 MCP 服务**：跑在服务端容器里，用 Streamable HTTP，只暴露平台数据。

早期版本按交付规格 §6.1 还提供过一个「Local MCP」——在开发者机器上以 stdio 运行、能读写受
白名单约束的仓库目录。它被移除了，原因是它没有存在的必要，还制造了两个真实问题：

1. **它无法被平台侧统一管理**。它由每个开发者各自的客户端进程拉起，版本、配置、能力都随
   机器而变；平台无法知道对面是哪个版本，也无法在不打扰用户的情况下更新它。
2. **它让「能力清单」失去唯一来源**。工具、resource、prompt 散在两台 Server 上，平台的
   发现接口（`GET /api/v1/mcp/tools`）只能把两份清单糊成一个扁平列表，结果是它声明了 6 条
   没有任何 Server 实现的 resource，还把一个已删除 Server 的 prompt 当成通用清单发布。

去掉之后，读写开发者仓库这件事仍然有人做，只是换了个更合适的载体：**CLI**（见 §3）。它同样
受 workspace 白名单、备份与原子写保护，但它是一个可以按版本固定、可以在 CI 里跑、出错时退出码
明确的普通命令行工具，而不是一个必须由 Agent 进程托管的 MCP 服务。

平台因此**永远无法主动访问开发者机器**：所有「本地动作」都在本地发起，平台只记录结果
（心跳、commit、apply report）。仓库 URL / 分支 / commit **不作为权限依据**。

## 2. Remote MCP

```bash
POST https://<host>/mcp
Authorization: Bearer lh_mcp_...
Content-Type: application/json
```

无状态（每个请求自带凭据），因此不存在跨租户的会话泄漏面。

### 2.1 接入教程

Web 端「MCP 管理 → 接入教程」是同一份流程，且会用**你自己的项目**生成示例。这里给读文档的人一份
自足的版本。

**还没有项目？从仓库初始化一个（第 0 步）。**

不需要先在网页上建项目。把仓库交给 Agent：

```text
读取这个仓库里的语言文件（locales/**），然后：
1. 用 create_project 建一个项目，source_locale 用源语言，locales 列出其余语言；
2. 把读到的内容用 import_translations 上传，先不传 confirm 看一遍会写什么，我确认后再传；
3. 把返回的 config 写进 .localehub/config.yaml。
```

两个工具的分工：

| 工具                  | 做什么                                                         | 返回                                                                      |
| --------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `create_project`      | 建项目（含语言、平台，并把创建者设为该项目的 PROJECT_MANAGER） | 项目 id，**以及可直接写入 `.localehub/config.yaml` 的完整内容**与后续步骤 |
| `import_translations` | 把一批语言文件内容写成 Key / 源文版本 / 译文                   | 默认 **dry-run**，只报告会写什么；`confirm=true` 才落库                   |

三个刻意的设计：

- **是 Agent 读文件，不是平台。** 平台够不到开发者的磁盘（§1），所以由 Agent 用自己的文件工具读
  语言文件、把内容交给 MCP。这也是为什么初始化必须由 Agent 发起。
- **配置是「返回」而不是「写入」。** `create_project` 返回配置文件的内容，由 Agent 写进仓库——
  平台不碰你的磁盘，这条边界在初始化路径上同样成立。
- **导入走的是 CLI 同一条管道**（scan → preview → push），所以「Agent 导入」与「CLI 推送」不可能
  在平台上留下不同的状态。默认 dry-run，与其余所有写操作一致。

初始化之后 CLI 就能接手：`localehub scan` → `localehub sync preview` → `sync push --confirm`。

**已有项目？从第 1 步开始。**

**第 1 步：签发 Token。** 「开发者 → API / MCP Token」→ 选 scopes → 签发。明文只显示一次。

| 用途                  | scopes                                                        |
| --------------------- | ------------------------------------------------------------- |
| 只读查看              | `project.read`、`translation.read`、`glossary.read`           |
| 让 Agent 写草稿       | 再加 `translation.write`                                      |
| 提交审核              | 再加 `translation.review`（仍需人类 REVIEWER 批准）           |
| 让 Agent 回报仓库写回 | 再加 `sync.push` / `translation.apply`（两者互相独立，见 §5） |

```bash
export LOCALEHUB_TOKEN="lh_mcp_…"   # 存进环境变量，不要提交到 Git
```

**第 2 步：拿到你的 `project_id`。** 18 个工具里有 16 个把它当第一个参数，而它是个 UUID——
不能靠猜。

两种拿法：

- 打开项目的详情页，标题旁就是 `project_id`，点一下即复制（项目页地址的最后一段也是它）；
- 或者直接问 Agent：`list_projects` **只返回这个 Token 能访问的项目**，所以它看到的是你的项目，
  不是别人的。这也是「数据自动适配使用者」的实现方式——过滤依据是 Token 绑定的
  `project_ids` 与用户自身的项目角色，不是你手动填的什么东西。

**第 3 步：把配置放进客户端。** 与本仓库、本地配置无关，只需要 URL 加 Token，可以配在任何机器上。

**第 4 步：验证。**

> 列出 LocaleHub 上我能访问的项目，然后读取 <你的项目> 的语言列表。

能看到自己的项目就说明通了。接着可以让它做事，例如：

> 用 project_id=<你的 project_id> 搜索待审核的译文，逐条给出审核建议。

> 用 project_id=<你的 project_id> 读取 QA 问题，给出修复后的译文并写入草稿。

### 2.2 配置片段

Remote MCP 与本仓库、本地配置**无关**：它只需要一个 URL 和一个 Token，因此可以配在任何地方
（另一台机器、CI、纯平台侧 Agent）。

平台页面「MCP 管理 → 客户端配置」把片段列出来，带复制按钮，URL 取服务端配置的 `MCP_PUBLIC_URL`；
片段由服务端用与 CLI 相同的生成器渲染，两边不会不一致。片段里永远只有 `${LOCALEHUB_TOKEN}`
这种环境变量引用，不会出现 Token 明文。

生成片段：

```bash
node apps/cli/dist/bin.js mcp-config                                # 向平台询问自己的 MCP 地址
node apps/cli/dist/bin.js mcp-config --remote https://example/mcp   # 或显式指定
```

得到：

```json
{
  "mcpServers": {
    "localehub-remote": {
      "type": "http",
      "url": "http://localhost:3003/mcp",
      "headers": { "Authorization": "Bearer ${LOCALEHUB_TOKEN}" }
    }
  }
}
```

放进 Claude Code / Cursor 的 MCP 配置（项目里的 `.mcp.json` 或用户级配置）并导出
`LOCALEHUB_TOKEN`，重启客户端即可。

Claude Code 也可以直接用命令行添加：

```bash
claude mcp add --transport http localehub-remote http://localhost:3003/mcp \
  --header "Authorization: Bearer $LOCALEHUB_TOKEN"
```

### 2.2.1 要点与约束

几个要点：

- **Token 是必须的**，不带 Token 的请求返回 401。用平台「开发者 → Token」签发，scope 按用途选：
  只读场景给 `project.read` + `translation.read` + `glossary.read`；需要让 Agent 写草稿再给
  `translation.write`；审核给 `translation.review`。
- **本地开发不需要配 CORS**：Remote MCP 是给 MCP 客户端直连的，不走浏览器。
- **不需要在仓库里装任何东西**：MCP 配置只描述一个远端 URL，与检出目录无关。
- 生产环境把 URL 换成 nginx 暴露的地址（`location /mcp` → `mcp-remote:3003`，见
  `docker/nginx/`）。
- 只支持 `POST /mcp`；`GET /mcp` 返回 405（无状态，没有 SSE 流可订阅）。

工具：`list_projects`、`get_project`、`list_project_locales`、`search_translation_keys`、
`get_translation_entry`、`get_glossary`、`search_translation_memory`、`translate_entries`、
`review_translation_entries`、`get_qa_issues`、`update_translation_draft`、`submit_review`、
`get_project_sync_status`、`get_pending_platform_changes`、`validate_release`。

工具标注（MCP `annotations`）：`translate_entries`、`review_translation_entries`、
`update_translation_draft`、`submit_review` 声明 `readOnlyHint: false`，其余 11 个为只读。
客户端据此可以判断哪些调用会改动平台数据。

约束：

- `translate_entries` 只写 **DRAFT**；
- `review_translation_entries` 需要 `REVIEWER` 角色，且不能批准 `STALE` 译文；
- 任何工具都不提供本地文件访问。

Resources / Prompts 清单可通过 `GET /api/v1/mcp/tools` 获取（含 JSON Schema）。该响应还包含
`skillDelivery`，即下发的 URI 模板与 prompt 前缀，供 Web UI 直接渲染。

### 2.3 使用者之间如何隔离

「别人用的数据要自动适配使用者的项目」这件事在平台上是这样落地的，每一层都不需要使用者手动配置：

| 层         | 机制                                                                                             |
| ---------- | ------------------------------------------------------------------------------------------------ |
| Token      | 绑定签发时的用户、组织与 `project_ids`；`list_projects` 与其余工具都按它过滤                     |
| 角色       | 同一个 Token 解析出的 actor 带用户的组织角色与项目角色，权限与浏览器登录完全一致                 |
| 数据库     | 每张租户表都有行级策略，`app.current_org_id` 之外的行走 SQL 层就不可见（§1.24）                  |
| 文档与示例 | Web 教程用**当前登录者自己的项目**生成 `project_id` 与示例提示词；文档里只有占位符，没有演示数据 |

因此接入者看到的项目列表、示例里的 id、能读到的译文，都是他自己的。平台侧不存在需要他「改成自己的」
配置项——URL 由部署方通过 `MCP_PUBLIC_URL` 决定，其余全部由 Token 推导。

### 2.4 每一次写入都会留痕

MCP 的写工具与 REST 写入**同一张 `audit_logs`**，所以「谁在什么时候推了什么」在两种入口下答案一致
——组织审计页读的就是这张表。此前 MCP 只写业务表、不写审计，结果是项目建好了、条目导入了，
审计页却一片空白。

| 工具                         | 审计 action                 | 记录内容                                             |
| ---------------------------- | --------------------------- | ---------------------------------------------------- |
| `create_project`             | `project.create`            | 项目名、源语言、语言列表                             |
| `import_translations`        | `sync.push`                 | `via: import_translations`、条目数、文件清单、summary |
| `translate_entries`          | `translation.ai_translate`  | 条目数、目标语言、provider（仅 `write_drafts` 时）    |
| `review_translation_entries` | `translation.review`        | 决定、处理数、跳过数、备注                           |
| `update_translation_draft`   | `translation.draft_update`  | key、locale、新版本 id（仅真正发生改动时）           |
| `submit_review`              | `translation.submit_review` | 提交数、跳过数、备注                                 |
| `mark_applied`               | `sync.apply`                | `via: mark_applied`、条数、跳过原因、git commit      |

- `actor_type` 为 `mcp`，`actor_id` 是 Token 所属用户，`mcp_client_id` 是具体那一把 Token
  ——「有人半夜推了四十个 key」因此能落到「哪把 Token」，可以直接撤销它。
- **只读不记账**：`list_projects`、`get_qa_issues`、`get_pending_platform_changes` 等只读工具不写审计；
  dry-run 同理，`import_translations {confirm:false}` 与 `translate_entries {write_drafts:false}`
  不留记录，否则审计页会把「看一眼」算成「改一次」。
- 写入前按**键名**脱敏（`token` / `secret` / `password` / `authorization` / `cookie` 等一律替换为
  `[redacted]`），Token 明文不可能进入这张表。
- 审计写入失败只记 stderr、不抛出：被记录的动作已经完成，不能因为记不上账就让它看起来失败了。
- 审计在**事务提交之后**写。`recordAudit` 用独立连接，如果放进业务事务里，回滚后这条记录会留下来，
  审计页就会声称一次没发生的审核「已批准」。
- `import_translations` 用的 action 与 REST 推送相同（`sync.push`），因为那本来就是同一件事；
  区分入口的是 `metadata.via`。

### 2.5 平台 → 仓库：闭环怎么合上

§2.4 之前，只有「仓库 → 平台」是通的：Agent 能读已审核译文、能自己写文件，但**没有任何工具能说
「我写完了」**。于是 `applied_to_repo_at` 永远为空，`get_pending_platform_changes` 每次都把同一批
变更再发一遍，`validate_release` 也一直把它们算作未落地。

`mark_applied` 补上这一半：

```jsonc
{
  "project_id": "...",
  "dry_run": false,
  "git_commit": "abc1234",
  "items": [
    { "key": "checkout.title", "locale": "ja-JP", "platform": "web",
      "file_path": "locales/ja-JP/common.json",
      "translation_version_id": "…" }   // get_pending_platform_changes 给的
  ]
}
```

它做四件事：写 `applied_to_repo_at` / `applied_to_repo_commit`、把三方比较的基线推到已收敛、
发一条 `SYNC_APPLIED` 事件、留一条 `sync.apply` 审计。还会建一条 `pull` 方向的 sync session 与
apply report，所以 Agent 的落地在同步历史里和人跑 CLI 的落地并排可见，而不是只有它自己知道。

**为什么每条都要带 `translation_version_id`。** 平台看不到开发者的磁盘，这条记录本质是**声明**
而不是**观测**——和 CLI 的 apply report 同一种信任。平台能验证的是：你声明的那个版本，是不是它现在
持有的版本。带旧版本号的条目会被判为 `VERSION_SUPERSEDED` 并**拒绝标记**：否则一个慢半拍的 Agent
会把昨天的译文写进仓库、标记为已落地，平台从此再也不会下发新的那条——这是系统里唯一没有任何其他
机制能发现的偏差方向。

其余判定：`NOT_FOUND`（没有这个 key）、`ALREADY_APPLIED`（重复调用是幂等的，不报错也不重复记事件）、
`DRAFT_NOT_ALLOWED`（未审核文本要落仓库，需要组织打开 `allowDraftApply`，与 REST 拉取同一条策略）。
`dry_run=true` 只回答不写，也不建 session。全部条目都没被接受时同样不建 session——空操作不该在历史
里留下一行。

### 2.6 Scope 是硬约束（本轮修复）

在此之前，MCP 服务端**只校验角色、完全不校验 scope**：一个只签了 `project.read` 的 Token 可以调用
`import_translations` 写库（实测确认）。这让规格 §2.2 的「`sync.push` 与 `translation.apply` 必须
分离授权」在唯一真正依赖它的入口上失效。

现在工具与 scope 的对应关系写在契约里（`REMOTE_MCP_TOOL_SCOPES`），并在 `define` 包装层统一断言
——放在包装层而不是各个 handler 里，是因为「忘了写的检查」等于「没有检查」：

| 工具                         | 需要的 scope                                |
| ---------------------------- | ------------------------------------------- |
| `import_translations`        | `repository.scan` + `sync.preview` + `sync.push` |
| `update_translation_draft`   | `translation.write`                         |
| `review_translation_entries` | `translation.review`                        |
| `mark_applied`               | `translation.apply`                         |

其余工具与 REST 对应路由一致：只需要角色。`translation.apply` 不在默认 scope 集合里，所以默认签发的
Token 推得上去、落不下来——这正是规格要的分离。

### 2.7 MCP 自己教怎么用：instructions / 资源 / 提示词 / 字段描述

上一轮暴露的问题很具体：一个 Agent 连上来，用「发畸形请求看报错」的方式摸 `import_translations` 的入参——
三次往返才问出 `files[0].entries[0].key`，而且**永远问不出带默认值的字段**，因为报错只会说必填项。带默认值
的恰好是最危险的三个（`platform`、`namespace`、`confirm`）。它自己给出的结论是「MCP 只报字段名，无文档」。

实际上 schema 一直是完整的。问题在于**没有任何一层在教**。现在四个层次各司其职：

| 层 | 内容 | 谁会看到 |
| --- | --- | --- |
| `instructions` | 两个方向别搞反、三条事后难改的规则、分批上限、dry-run 默认 | 客户端在调用任何工具前放进上下文 |
| `localehub://import-guide` | 完整上传教程：调用形状、逐条规则、实测边界、推荐顺序、`.strings` 解析坑 | Agent 按需读取 |
| `import-localization-files` 提示词 | 七步流程，供人在客户端里直接唤起 | 人（斜杠命令） |
| 工具与字段的 `description` | 每个字段在什么情况下会出错（如 `platform` 默认 `web`，iOS 必须显式传） | 随 `tools/list` 一起下发 |

关键一条：**字段描述随 schema 走，所以默认值也能被解释**。`platform` 的 schema 现在是
`{"default":"web","description":"默认是 web：iOS 请传 'ios' …platform 是 key 身份的一部分"}`——
这正是试错法拿不到的信息。

### 2.8 一次导入的开销由「这一批」决定，不由「项目多大」决定

曾经不是这样，而且症状极具误导性：往一个有 5,480 条译文的项目里导入 **1 个 key** 会超时失败，导入多少条
都一样。原因是同步计划为**项目已有的每一条**都生成了一个 item（包括无事可做的那些），`push` 再为每个 item
写一行 `sync_items`——一次推送的成本与项目规模成正比，而不是与改动量成正比。

两处修正（详见 [SYNC.md](./SYNC.md) §3.1–§3.3）：

1. **计划只装要做的事**：`SKIP` 不再进计划，`summary.unchanged` 仍然统计它们。
2. **批次是部分扫描**：`sync_scans.partial` 让一次导入不对它没带的文件表态，因此不会把历史条目判成删除。
3. 写入量由调用方决定的路径有了独立的 60 秒事务预算（`withOrganizationBulk`），而不是 Prisma 的 5 秒默认值。

实测：往 10,400 条的项目里导入 1 条 **1.1 秒成功**；向同一个项目连续填 10,400 条（每批 800 条）全部通过。

分批依然值得做——请求体上限 4 MB，一次几万条没有必要——但**分批的理由不再是「否则必失败」**，而且
超时整批回滚、重跑幂等（`unchanged` 会告诉你上次是否已生效）。

### 2.9 仓库有、平台没有的语言：自动扩充

项目已有的语言是既有事实，仓库自己有哪些语言同样是既有事实。所以导入时以仓库为准：

| 情况 | 平台怎么做 |
| --- | --- |
| 完全相同 | 直接用 |
| 等价标签（项目 `zh-CN`，仓库 `zh-Hans`；项目 `en-US`，仓库 `en`） | 归入已有的那个，报告在 `expansion.localesMatched` |
| 项目没有（仓库多了 `ko.lproj`） | **自动新增**，带中文可读名（`韩语`），报告在 `expansion.localesAdded` |
| 无法判断（项目同时有 `zh-CN` 和 `zh-TW`，来的是 `zh`） | **拒绝**并列出候选，要求传确切代码 |

平台（端）同理：项目只声明了 `web`，仓库来了 `ios` 的内容，就自动加上，报告在 `expansion.platformsAdded`。

**等价判断只在脚本与地区真正互替时成立**（`zh-Hans` ↔ `zh-CN`、`zh-Hant` ↔ `zh-TW`），或标签是光秃秃的语言
（`ja` 对上唯一的 `ja-JP`）。它**不会**把 `zh-Hant` 认成 `zh-CN`——那会把繁体文本归到简体下。

**为什么不能含糊。** 源文是靠 `locale === sourceLocale` 认出来的。在这一条之前，一个 iOS 仓库
（源目录是 `zh-Hans.lproj`）配一个 `zh-CN` 的项目，导入会**新建一个 zh-Hans 语言**，而且因为代码不再等于
`sourceLocale`，这批内容根本不算源文：**一条 source version 都不会生成**，译文全部
`basedOnSourceVersionId = null`。项目变成「有译文、没有原文」，占位符校验、源文变更标 stale、AI 翻译都没了
参照物——全程不报错。

**dry run 也会报。** 「什么都没写」在调用方真正想知道「这次导入会让项目变成什么样」时是没用的，所以
`confirm=false` 同样返回 `expansion`。

**痕迹留在三处**：返回值、`sync.push` 审计行（`localesAdded` / `localesMatched` / `platformsAdded`），以及
CLI 的 `localehub scan` 输出（`expanded` 字段直接给中文说明）。「这个 zh-Hant 是哪来的」因此有答案。

## 3. 本地仓库操作：CLI（不是 MCP）

读写开发者仓库的 14 个动作都在 CLI 里，`localehub <command>`。它们与 MCP 无关，也不需要
MCP：Agent 可以用 Bash 调用，CI 可以直接调用，人也可以在终端里调用。

```bash
node apps/cli/dist/bin.js scan                # 扫描语言文件并规范化
node apps/cli/dist/bin.js sync preview        # 三方比较，只读
node apps/cli/dist/bin.js sync push --confirm # 推送本地变更
node apps/cli/dist/bin.js pull                # 查询平台已审核译文
node apps/cli/dist/bin.js apply preview       # 回写 dry-run
node apps/cli/dist/bin.js apply --confirm     # 备份 + 原子写回
node apps/cli/dist/bin.js conflicts           # 列出未解决冲突
node apps/cli/dist/bin.js qa                  # 本地格式/占位符/缺译校验
node apps/cli/dist/bin.js status              # 本地状态 + 远端状态
node apps/cli/dist/bin.js patch               # 生成 patch/diff，不 commit
node apps/cli/dist/bin.js release validate    # 发布前校验
node apps/cli/dist/bin.js info                # 配置、workspace root、Git 状态
node apps/cli/dist/bin.js mcp-config          # 打印 MCP 客户端配置片段
```

| 动作                  | 默认行为               | 说明                                                    |
| --------------------- | ---------------------- | ------------------------------------------------------- |
| `info`                | 只读                   | 配置、workspace root、Git 分支/commit、映射             |
| `scan`                | 只读（上传规范化条目） | 扫描配置声明的语言文件；返回文件数/Key 数/警告          |
| `sync preview`        | 只读                   | 三方比较，生成变更计划                                  |
| `sync push`           | **必须 `--confirm`**   | 只能提交此前生成且未过期的计划                          |
| `pull`                | 只读                   | 默认只返回 `APPROVED`                                   |
| `apply preview`       | dry-run                | 逐文件逐 Key 的旧值/新值/风险                           |
| `apply --confirm`     | **必须二次确认**       | 备份 + 原子写入 + 重解析校验                            |
| `qa`                  | 只读                   | 格式、占位符、重复 Key、缺译                            |
| `status`              | 只读                   | 本地状态 + 远端状态 + 未解决冲突                        |
| `conflicts --resolve` | 显式选择               | `KEEP_LOCAL` / `KEEP_REMOTE` / `MANUAL_MERGE` / `DEFER` |
| `patch`               | 只读                   | 生成 patch/diff，**不 commit**                          |
| `release validate`    | 只读                   | 发布前校验清单                                          |

三件事仍然受保护，与有没有 MCP 无关：

- **workspace 白名单**：`allowRead` / `allowWrite` / `denyRead` / `denyWrite` 在每次路径解析时
  生效，拒绝 `..` 与符号链接逃逸（`packages/workspace`）；
- **备份与原子写**：写回前备份、临时文件原子替换、写后重新解析校验（`SafeFileWriter`）；
- **先预览后确认**：`sync push` 与 `apply` 都要求显式确认，默认 dry-run。

### 本地状态

`.localehub/state.json` 记录 `lastScanId`、`lastPreview`、`pendingApplyPlans`、`lastApplyReport`、
`history`。只保存标识与哈希，不保存 Token。`.localehub/backups|patches|reports` 存放产物，
已在 `.gitignore` 中忽略，且扫描时会跳过整个 `.localehub` 目录。

Agent 侧的正确用法：需要平台的三方比较、冲突检测与基线记录时，让 Agent 用 Bash 跑上面的命令，
而不是绕过它们直接改译文文件——直接改会让平台失去基线，冲突检测随之失效。

## 4. Skill 下发

Skill（工作流程与规范文档）通过 MCP 以 resource 下发，指令型 Skill 额外注册一个 prompt：

| 用途 | URI / 名称                  | 内容                                                          |
| ---- | --------------------------- | ------------------------------------------------------------- |
| 清单 | `localehub://skills`        | Markdown 表格，列出每个 Skill 的 resource URI 与 prompt 名称  |
| 正文 | `localehub://skills/{slug}` | 完整 `SKILL.md`，`text/markdown`                              |
| 调用 | `skill-<slug>`              | 仅 `PUBLISHED` + `kind=PROMPT`；可选参数 `focus` 指定本次范围 |

只下发 `PUBLISHED` 的最高版本；`kind=SCRIPT` 的 Skill 只有 resource，没有 prompt。完整规则见
[docs/SKILLS.md](./SKILLS.md#4-通过-mcp-下发给客户端)。

Server 每个请求建一次（无状态），所以 Skill 是**实时**的：新发布的 Skill 下一个请求就能读到，
不需要重启任何客户端。

取数走数据库、受 RLS 约束，与 `GET /skills` 的可见性规则一致。查询失败时只记 stderr 并返回空清单
——Skill 是附加能力，不能因为读不到它而让 18 个工具一起报错。

## 5. Token 与 Scope

```json
{
  "organization_id": "org_uuid",
  "project_ids": ["project_uuid"],
  "scopes": [
    "project.read",
    "repository.scan",
    "sync.preview",
    "sync.push",
    "translation.read",
    "translation.pull",
    "translation.apply",
    "qa.execute"
  ],
  "expires_at": "2026-12-09T00:00:00Z"
}
```

- `sync.push`（提交本地变更到平台）与 `translation.apply`（把平台变更写入本地）**分离授权**。
- `release.publish` 必须单独授予，不能被其他 scope 隐式获得。
- Token 明文只在创建时显示一次，数据库仅存 SHA-256 哈希；撤销立即生效。
- 文件系统边界由**本地配置**决定，不依赖平台 Token。

## 6. 配置校验（启动时执行）

`.localehub/config.yaml` 加载时会检查并拒绝：

- 缺少 source 映射、映射缺少 locale、映射使用绝对路径或 `..`；
- `allowWrite` 覆盖源码文件（只允许语言资源）；
- workspace glob 绝对路径或包含 `..`；
- 配置文件中出现内联 secret（必须用 `tokenEnv`）。

并给出警告：多个 source 映射、映射不可写、未被任何映射覆盖的本地化文件（`UNMAPPED_FILE`）。
