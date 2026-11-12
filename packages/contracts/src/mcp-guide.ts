/**
 * What the Remote MCP tells a client about itself.
 *
 * The server's `instructions` is the one piece of text a client is expected to put in front of the
 * model before any tool call, so it is where "how do I use this" has to be answered. It used to be
 * two sentences describing what the server *cannot* do, and an agent connecting to it had to learn
 * the tool shapes by sending deliberately malformed calls and reading the validation errors — three
 * round trips to discover `files[0].entries[0].key`, and it never discovered the fields that have
 * defaults, which are exactly the ones that decide whether the import lands correctly.
 *
 * The guide below is deliberately specific. Vague guidance ("provide the localization files") is
 * what produced the probing; the rules that follow are the ones a caller cannot infer from the
 * schema and cannot recover from afterwards.
 */

/**
 * Server instructions: kept short because every client shows it, and every word costs context.
 * The detail lives in `localehub://import-guide`, which a client fetches only when it needs it.
 */
export const REMOTE_MCP_INSTRUCTIONS = [
  'LocaleHub：本地化平台。这里只有平台侧数据与业务工具（项目、Key、译文、术语、翻译记忆、QA、审核、同步），',
  '它无法访问开发者的本地文件系统——读写仓库文件由 CLI（localehub）或你自己的文件工具完成。',
  '',
  '两个方向，别搞反：',
  '· 仓库 → 平台：import_translations（首次导入）、CLI 的 sync push（日常）。',
  '· 平台 → 仓库：get_pending_platform_changes 读出已审核译文 → 你写进文件 → mark_applied 回报。',
  '',
  '上传（import_translations）前必读 localehub://import-guide。三条最容易出错的规则：',
  '· locale 按仓库实际目录填（zh-Hans.lproj 就传 zh-Hans）：等价的标签会归入项目已有的语言（zh-Hans → zh-CN、en → en-US），',
  '  项目没有的语言会自动新增并在返回值与审计里报告；只有「项目同时有 zh-CN 和 zh-TW，来的却是 zh」这种无法判断的情况才会被拒；',
  '· platform 默认是 web，iOS 必须显式传 ios，且要与仓库配置里的 platform 一致；项目没有这个端也会自动加上；',
  '· 一次调用只放 300~400 条，整个导入在一个 5 秒的事务里（实测 400 条通过、1000 条超时），超时会整批回滚。',
  '',
  '所有写操作默认 dry run（confirm/dry_run 缺省为 false）：先看不写，确认后再落库。',
  'AI 生成的译文一律是草稿；审核与发布必须由具备权限的人类完成，Agent 的批准会被拒绝——这是设计。',
].join('\n');

/**
 * The upload guide, served as `localehub://import-guide`.
 *
 * Markdown rather than JSON because its reader is a model, and every rule here is one that a
 * caller either cannot discover from the schema (defaults are invisible) or cannot undo (a locale
 * code, a platform, a namespace are all part of a key's identity).
 */
export const REMOTE_MCP_IMPORT_GUIDE = `# 把本地语言文件上传到平台

## 0. 先读，别试错

工具的完整入参 schema 会随 \`tools/list\` 一起下发，包含类型、必填项与默认值。不要用「发一个畸形请求看报错」的方式
摸形状——报错只会告诉你**必填**字段，凡是带默认值的字段全部隐身，而这里带默认值的字段恰好是最危险的三个
（\`platform\`、\`namespace\`、\`confirm\`）。

## 1. 调用形状

\`\`\`jsonc
{
  "project_id": "<uuid>",
  "confirm": false,                       // 默认 false = 只报告不写入
  "files": [
    {
      "path": "locales/ja-JP/Localizable.strings",  // 仓库里的相对路径，仅作标识
      "locale": "ja-JP",                            // BCP 47；必须与项目 locale 完全一致
      "platform": "ios",                            // 默认 web —— iOS 必须显式传 ios
      "namespace": "Localizable",                   // 可选；多张字符串表必须靠它区分
      "entries": [{ "key": "checkout.title", "value": "お会計" }]
    }
  ]
}
\`\`\`

## 2. 三条事后难改的规则

**locale 填仓库里的实际目录名，平台会自己对齐。** 项目是权威项目已有的语言，仓库是权威它自己有哪些语言：

| 情况 | 平台怎么做 |
| --- | --- |
| 完全相同（项目有 \`zh-CN\`，你来 \`zh-CN\`） | 直接用 |
| 等价标签（项目有 \`zh-CN\`，你来 \`zh-Hans\`；项目有 \`en-US\`，你来 \`en\`） | 归入已有的那个，并在返回值 \`expansion.localesMatched\` 里报告 |
| 项目没有（项目只有 \`en-US\`，你来 \`fr-FR\`） | **自动新增**，带可读名字（\`Français（France）\`），在 \`expansion.localesAdded\` 里报告 |
| 无法判断（项目同时有 \`zh-CN\` 和 \`zh-TW\`，你来 \`zh\`） | **拒绝**并列出候选，要求传确切代码——猜错会把文本归到错误的语言下，且很难回头 |

等价判断只在脚本与地区真正互替时成立（\`zh-Hans\` ↔ \`zh-CN\`、\`zh-Hant\` ↔ \`zh-TW\`），或标签是光秃秃的语言
（\`ja\` 对上唯一的 \`ja-JP\`）。它**不会**把 \`zh-Hant\` 认成 \`zh-CN\`。

为什么这件事重要：源文是靠 \`locale === sourceLocale\` 认出来的。以前 \`zh-Hans\` 不被认成 \`zh-CN\`，于是
**一条 source version 都不生成**，译文全部 \`basedOnSourceVersionId = null\`——项目变成「有译文、没有原文」，
占位符校验、源文变更标 stale、AI 翻译都没有参照物。

**platform 决定 key 的身份。** key 的身份是 \`(项目, platform, namespace, key)\`。要与
\`.localehub/config.yaml\` 里文件映射的 \`platform\` 一致：导入成 \`web\`、之后用 \`ios\` 扫同一批文件，平台会认为是
两套不相干的 key，表现为「一批新 key + 一批待归档」，不报错。iOS 用 \`ios\`，Android 用 \`android\`，
多端共用一份文案用 \`universal\`。项目没有这个端时也会自动加上，并在 \`expansion.platformsAdded\` 里报告。

**多张字符串表要用 namespace 分开。** key 的身份里**没有文件路径**。iOS 的 \`Localizable\` / \`InfoPlist\` /
\`LaunchScreen\` 是三张独立的表，都用默认空 namespace 导入就是拍平成一个 key 空间，同名 key 互相覆盖（后写的赢，
不报错）。用 \`namespace\` 承载表名。

## 3. 必须分批

整个导入（scan → preview → push）在**一个 Prisma 交互式事务**里，其默认超时是 **5 秒**。实测：

| 单次调用条目数 | 结果 |
| --- | --- |
| 400 | 成功（约 3.2 秒） |
| 1000 | 失败：\`Transaction already closed ... timeout was 5000 ms\` |
| 1400 | 失败：同上 |

超过上限时**整批回滚，不会写入半份**。所以：

- 按「文件 × 语言」分批，每批 **300~400 条**，留出余量。
- 分批是安全的：对未改动的值重复导入会判为 \`changed:false\`（不产生重复版本），可以放心重跑。
- MCP 请求体上限 4 MB，是第二个分批的理由。

一万条 key 就是大约 30 次调用。这不优雅，但它是当前实现的真实边界——先按这个做。

## 4. 推荐顺序

1. \`get_project\` + \`list_project_locales\` —— 拿到 sourceLocale 与已有语言代码，**不要猜**。
2. 若 platform 不对（例如项目建成了 \`web\` 但内容是 iOS），先处理它：平台上没有任何工具能改
   \`sourceLocale\`，也没有工具能给项目加 platform；项目还是空的时候重建最便宜。\`create_project\` 接受 \`platforms\`。
3. 每个文件先 \`confirm: false\` 跑一次 dry run：核对 \`files[].isSource\`（源文判定按**归入之后**的代码算）、
   \`entryCount\`，以及 \`expansion\`——它会告诉你这次导入会新增哪些语言、把哪些标签归入已有语言、新增哪个端。
   dry run 只回答不写。
4. 分批 \`confirm: true\` 导入，从源语言文件开始。
5. 全部导入后 \`get_project\` 看 counts，再用 \`get_qa_issues\` 跑一遍。
6. 平台 → 仓库方向：\`get_pending_platform_changes\` → 写文件 → \`mark_applied\`（需要 \`translation.apply\` scope）。

## 5. 解析本地文件

\`.strings\` 的坑：UTF-16 + BOM、\`/* 注释 */\`、\`\\"\` \`\\n\` \`\\\\\` \`\\uXXXX\` 转义、重复 key、值里出现 \`=\`。
解析错一位，平台存下的 \`contentHash\` 就是错的，之后每次同步都会冒出假 diff。
平台的解析器（\`packages/format-adapters/src/adapters/ios-strings.ts\` 的 \`parseAppleStrings\`）可以作为行为参照。
`;

/**
 * The prompt body for the upload flow. Registered as a prompt so a person can invoke it from their
 * client, and written so that pasting it into any agent produces the same sequence.
 */
export function remoteImportPrompt(args: { projectId?: string; localesDir?: string } = {}): string {
  const project = args.projectId ? `project_id=${args.projectId}` : '先调 list_projects 拿到 project_id';
  const dir = args.localesDir ?? '仓库里的语言资源目录';
  return [
    `把 ${dir} 下的语言文件上传到 LocaleHub（${project}）。`,
    '',
    '按这个顺序做，不要跳步：',
    '1. 读 localehub://import-guide，它是这个流程的权威说明。',
    '2. 用你自己的文件工具读语言文件，解析成 key/value（注意 UTF-16 BOM、注释、转义、重复 key）。',
    '3. 调 get_project 与 list_project_locales，拿到 sourceLocale 和已有语言代码。',
    '4. 决定两件事并说明理由：每个文件用哪个 locale（必须与项目里的代码逐字符相同）、用哪个 platform。',
    '5. 先 confirm=false 跑 dry run，把 isSource 判定与条目数报给我确认。',
    '6. 我确认后，按每批 300~400 条分批 confirm=true 导入，从源语言文件开始。',
    '7. 导入完成后调 get_project 核对 counts，并跑一次 get_qa_issues。',
    '',
    '任何一步发现 platform 或 locale 与项目现状不符，先停下来告诉我——这两样是 key 身份的一部分，导完再改要重导。',
  ].join('\n');
}
