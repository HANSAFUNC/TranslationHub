import { z } from 'zod';

/**
 * Skill delivery over MCP.
 *
 * A Skill is a *document* — a SKILL.md plus its frontmatter — so it travels over MCP as a
 * **resource** (`localehub://skills/{slug}`), which any client can pull into context. Instruction
 * type skills additionally get an MCP **prompt**, which clients surface as an invocable command.
 *
 * Deliberately not tools: spec §6.2 fixes the tool surface at 14 local / 15 remote, and reading
 * published instructions is not a capability that needs an authorization of its own (the REST
 * equivalent, `GET /skills`, carries no role or scope requirement either).
 *
 * Both MCP servers and the web UI derive every address from this module, so a skill has exactly
 * one URI and one prompt name everywhere it appears.
 */

export const SKILLS_INDEX_URI = 'localehub://skills';
export const SKILL_RESOURCE_TEMPLATE = 'localehub://skills/{slug}';

/**
 * Skill prompts are prefixed so a user-registered slug can never silently overwrite one of the
 * hand-written prompts the server ships (`review-localization-changes` and friends). The prefix
 * also groups them together in a client's command list.
 */
export const SKILL_PROMPT_PREFIX = 'skill-';

export function skillResourceUri(slug: string): string {
  return `localehub://skills/${slug}`;
}

export function skillPromptName(slug: string): string {
  return `${SKILL_PROMPT_PREFIX}${slug}`;
}

/** Optional narrowing argument shared by every skill prompt. */
export const skillPromptArgs = {
  focus: z.string().max(500).optional().describe('本次要处理的范围（语言、命名空间、文件或 Key），留空表示按 Skill 默认流程执行'),
};

/** The columns skill delivery needs. The API returns whole rows; only these are read. */
export interface SkillSourceRow {
  slug: string;
  name: string;
  description?: string | null;
  version: string;
  kind: string;
  status: string;
  content: string;
}

export interface DeliveredSkill {
  slug: string;
  name: string;
  description: string | null;
  version: string;
  kind: string;
  content: string;
  resourceUri: string;
  /** `null` when this skill is not delivered as an invocable prompt (see `selectDeliverableSkills`). */
  promptName: string | null;
}

/**
 * Semver-ish ordering for version strings.
 *
 * Numeric segments compare as numbers ("1.10.0" beats "1.9.0", which a string sort gets wrong),
 * a missing segment counts as zero ("1.0" === "1.0.0"), and — as in semver — a pre-release sorts
 * *below* the release it precedes ("1.0.0-beta.1" < "1.0.0"). Build metadata is ignored.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (version: string): { main: string[]; pre: string[] | null } => {
    const withoutBuild = version.split('+')[0] ?? '';
    const dash = withoutBuild.indexOf('-');
    const main = (dash === -1 ? withoutBuild : withoutBuild.slice(0, dash)).split('.');
    return { main, pre: dash === -1 ? null : withoutBuild.slice(dash + 1).split('.') };
  };
  const left = parse(a);
  const right = parse(b);

  for (let i = 0; i < Math.max(left.main.length, right.main.length); i += 1) {
    const x = left.main[i];
    const y = right.main[i];
    if (x === undefined) return y !== undefined && Number(y) !== 0 ? -1 : 0;
    if (y === undefined) return Number(x) !== 0 ? 1 : 0;
    const nx = Number(x);
    const ny = Number(y);
    const numeric = Number.isFinite(nx) && Number.isFinite(ny) && x !== '' && y !== '';
    if (numeric) {
      if (nx !== ny) return nx < ny ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }

  if (left.pre === null && right.pre === null) return 0;
  if (left.pre === null) return 1; // a release outranks its pre-releases
  if (right.pre === null) return -1;

  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i += 1) {
    const x = left.pre[i];
    const y = right.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = Number(x);
    const ny = Number(y);
    const numeric = Number.isFinite(nx) && Number.isFinite(ny) && x !== '' && y !== '';
    // Semver: numeric identifiers sort below alphanumeric ones.
    if (numeric && !(Number.isFinite(ny) && y !== '')) return -1;
    if (!(Number.isFinite(nx) && x !== '') && numeric) return 1;
    if (numeric) {
      if (nx !== ny) return nx < ny ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Reduce skill rows to what should be handed to a client.
 *
 * - only PUBLISHED skills: a DRAFT is somebody's work in progress and a DISABLED skill was turned
 *   off on purpose, so neither belongs in an agent's context;
 * - one entry per slug, highest version wins (the API orders rows for display, not for this);
 * - prompts only for `PROMPT` kind. A SCRIPT skill's body is a program to be reviewed and run by
 *   an executor, not a message to inject into a conversation — it is still readable as a resource;
 * - `promptName` stays `null` if the derived name would land on a prompt the server already
 *   registers itself, because the second `registerPrompt` for a name silently wins otherwise.
 */
export function selectDeliverableSkills(
  rows: readonly SkillSourceRow[],
  options: { reservedPromptNames?: readonly string[] } = {},
): DeliveredSkill[] {
  const reserved = new Set(options.reservedPromptNames ?? []);
  const bySlug = new Map<string, SkillSourceRow>();
  for (const row of rows) {
    if (row.status !== 'PUBLISHED') continue;
    const current = bySlug.get(row.slug);
    if (!current || compareVersions(row.version, current.version) > 0) bySlug.set(row.slug, row);
  }

  return [...bySlug.values()]
    .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .map((row) => {
      const promptName = skillPromptName(row.slug);
      const deliverAsPrompt = row.kind === 'PROMPT' && !reserved.has(promptName);
      return {
        slug: row.slug,
        name: row.name,
        description: row.description ?? null,
        version: row.version,
        kind: row.kind,
        content: row.content,
        resourceUri: skillResourceUri(row.slug),
        promptName: deliverAsPrompt ? promptName : null,
      };
    });
}

/**
 * The SKILL.md without its YAML frontmatter.
 *
 * Frontmatter is metadata for the client (name, version, required tools); injecting it as the
 * first thing an agent reads in a conversation is noise. The resource keeps the file verbatim —
 * only the prompt message is trimmed.
 */
export function skillBody(content: string): string {
  if (!content.startsWith('---')) return content.trim();
  const end = content.indexOf('\n---', 3);
  if (end === -1) return content.trim();
  const after = content.indexOf('\n', end + 1);
  return (after === -1 ? '' : content.slice(after + 1)).trim();
}

/** `localehub://skills` — the index a client reads first to discover what is available. */
export function renderSkillIndex(skills: readonly DeliveredSkill[]): string {
  if (!skills.length) {
    return [
      '# LocaleHub Skills',
      '',
      '当前组织下没有已发布的 Skill。',
      '',
      'Skill 由具备 PROJECT_MANAGER 及以上角色的成员通过 `POST /api/v1/skills` 注册，',
      '只有 `PUBLISHED` 状态的版本会下发给客户端。',
      '',
    ].join('\n');
  }

  const lines = [
    '# LocaleHub Skills',
    '',
    `${skills.length} 个已发布 Skill。读取对应 resource 获取完整内容。`,
    '',
    '| Slug | 名称 | 版本 | 类型 | Resource | Prompt |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const skill of skills) {
    const name = skill.name.replace(/\|/g, '\\|');
    lines.push(
      `| \`${skill.slug}\` | ${name} | ${skill.version} | ${skill.kind} | \`${skill.resourceUri}\` | ${
        skill.promptName ? `\`${skill.promptName}\`` : '—'
      } |`,
    );
  }
  lines.push('', '## 说明', '');
  for (const skill of skills) {
    lines.push(`### ${skill.name} (\`${skill.slug}\`)`, '', skill.description ?? '（无描述）', '');
  }
  return lines.join('\n');
}
