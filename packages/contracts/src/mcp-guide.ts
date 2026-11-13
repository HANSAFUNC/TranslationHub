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
  '顺手（可选）：upload_screen_mockup 上传一张界面草图与若干标记，标出每个 key 的文字在界面上的位置——',
  '译者在编辑器里就能对着界面看译文。坐标是相对图片的比例（0~1），不是像素；key 还没导入也能标，之后导入会自动对上。',
  '注意 upload_screen_mockup 没有 dry run：同名再传是整体替换（旧图与旧标记不再保留），所以别拿它「先试一下」。',
  '',
  '先看不写这件事只有两个工具提供：import_translations 用 confirm=true 才落库，mark_applied 用 dry_run=true 只看结果。',
  '其余写工具（translate_entries、review_translation_entries、update_translation_draft、create_project、upload_screen_mockup）一调即写，没有预演。',
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

## 3. 分批，以及为什么分批是安全的

整个导入（scan → preview → push）在**一个事务**里，写入量由这一批的条数决定。超时会**整批回滚，不会写半份**，
所以失败是干净的：减小批次重跑即可。

一次调用的开销**只与这一批的条数有关，与项目已经有多大无关**。所以：

- 按「文件 × 语言」分批，每批几百条即可（一次几万条既没有必要，也会撞上请求体上限）。
- 分批**不会**把没在这一批里的 key 判成删除：导入是**部分上传**，它只说「这几个文件是这样」，
  不对其余文件表态。这一点由平台保证，不需要你做什么。
- 对未改动的值重复导入是幂等的（不产生重复版本），返回值里的 \`unchanged\` 就是这些条数。可以放心重跑。
- MCP 请求体上限 4 MB，是另一个分批的理由。

一万条 key 大约 25~30 次调用。如果某次仍然超时，那是这一批太大或数据库正忙——减小批次，不要试图一次发完。

## 4. 推荐顺序

1. \`get_project\` + \`list_project_locales\` —— 拿到 sourceLocale 与已有语言代码，**不要猜**。
2. 若 platform 不对（例如项目建成了 \`web\` 但内容是 iOS），先处理它：平台上没有任何工具能改
   \`sourceLocale\`，也没有工具能给项目加 platform；项目还是空的时候重建最便宜。\`create_project\` 接受 \`platforms\`。
3. 每个文件先 \`confirm: false\` 跑一次 dry run：核对 \`files[].isSource\`（源文判定按**归入之后**的代码算）、
   \`entryCount\`，以及 \`expansion\`——它会告诉你这次导入会新增哪些语言、把哪些标签归入已有语言、新增哪个端。
   dry run 只回答不写。
   确认导入后的返回值里还有 \`unchanged\`：本次内容与平台已有译文完全一致的条数。它不写库，所以**重跑同一个
   文件是安全的**——看这个数就知道上次是不是已经生效了。
4. 分批 \`confirm: true\` 导入，从源语言文件开始。
5. 全部导入后 \`get_project\` 看 counts，再用 \`get_qa_issues\` 跑一遍。
6. 平台 → 仓库方向：\`get_pending_platform_changes\` → 写文件 → \`mark_applied\`（需要 \`translation.apply\` scope）。

## 5. 为什么可以放心分批

MCP 的导入每次都是一次**部分上传**：它只说「这几个文件是这样」，不会说「其余文件没了」。所以按批导入不会把
没在这一批里的 key 判成删除——这一点由平台保证，不需要调用方做什么。

一次调用的开销只和**这一批的条数**有关，和项目已经有多大无关。（早先不是这样：计划里会为项目已有的每一条
都生成一个条目，于是往一个有几千条的项目里导入 1 个 key 也会超时。已修。）

## 6. 顺手把界面草图传上来（可选，但很值）

译文缺的从来不是词，是**位置**。\`checkout.pay_now\` 这三个词到了译者手上没有按钮。把界面画下来、
标出每个 key 的文字在哪，编辑器的「界面草图」按钮就会把图与译文并排显示，点标记跳到译文、选译文点亮标记。

\`\`\`jsonc
{
  "project_id": "<uuid>",
  "name": "checkout",            // 屏幕的身份：同名再传一次 = 整体替换
  "platform": "ios",             // 这张图的端；同名 key 在多个端都有时优先取该端那条
  // replace 默认 true：同名再传=整体替换，没有 dry run，也没有历史版本
  "locale": "en-US",             // 图里文字的语言，通常就是 sourceLocale
  "image_base64": "<base64>",    // SVG / PNG / JPEG，解码后 ≤ 2 MB；SVG 最省事
  "markers": [
    { "key": "checkout.title", "x": 0.08, "y": 0.06, "width": 0.4, "height": 0.05, "text": "Checkout" }
  ],
  "replace": true
}
\`\`\`

三条要点：

1. **坐标是比例，不是像素。** \`x\`/\`y\` 是左/上边缘占图片宽高的比例（0~1），\`width\`/\`height\` 可选。
   比例坐标让同一张图在任何尺寸下都对齐，换 2x 导出也不用重标。
2. **可以比导入先做。** 指向尚未导入的 key 不会失败，返回值里以 \`markers.unmatched\` 报告；
   之后 \`import_translations\` 把这些 key 导进来，标记自动对上译文，不用重传草图。
3. **SVG 里不要放 \`<script>\`、事件属性（\`onload\`）或 \`<foreignObject>\`。** 会被直接拒绝并告诉你删哪个——
   草图只需要图形和文字。

## 7. 解析本地文件

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
