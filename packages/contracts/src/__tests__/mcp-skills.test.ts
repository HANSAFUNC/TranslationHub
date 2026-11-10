import { describe, expect, it } from 'vitest';

import {
  SKILLS_INDEX_URI,
  compareVersions,
  renderSkillIndex,
  selectDeliverableSkills,
  skillBody,
  skillPromptName,
  skillResourceUri,
  type SkillSourceRow,
} from '../mcp-skills';

function row(overrides: Partial<SkillSourceRow> & Pick<SkillSourceRow, 'slug'>): SkillSourceRow {
  return {
    name: overrides.slug,
    description: null,
    version: '1.0.0',
    kind: 'PROMPT',
    status: 'PUBLISHED',
    content: `---\nname: ${overrides.slug}\n---\nbody of ${overrides.slug}`,
    ...overrides,
  } as SkillSourceRow;
}

describe('skill addresses', () => {
  it('derives one URI and one prompt name per slug', () => {
    expect(SKILLS_INDEX_URI).toBe('localehub://skills');
    expect(skillResourceUri('translation-review')).toBe('localehub://skills/translation-review');
    expect(skillPromptName('translation-review')).toBe('skill-translation-review');
  });

  it('prefixes prompts so a skill can never collide with a built-in prompt name', () => {
    // The four built-in prompts are bare names (`fix-translation-issues`). A skill slug is
    // `[a-z0-9-]` too, so without the prefix `fix-translation-issues` could be registered twice —
    // and the SDK throws on the second registration, taking the whole server down.
    expect(skillPromptName('fix-translation-issues')).not.toBe('fix-translation-issues');
  });
});

describe('compareVersions', () => {
  it('orders numerically, not lexically', () => {
    expect(compareVersions('1.10.0', '1.9.0')).toBeGreaterThan(0);
    expect(compareVersions('2.0.0', '10.0.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
  });

  it('handles a missing segment and a pre-release suffix', () => {
    // A missing segment counts as zero, so these are the same version (as in semver).
    expect(compareVersions('1.0', '1.0.0')).toBe(0);
    expect(compareVersions('1.0.0-beta.1', '1.0.0')).toBeLessThan(0);
  });
});

describe('selectDeliverableSkills', () => {
  it('keeps only PUBLISHED skills', () => {
    const skills = selectDeliverableSkills([
      row({ slug: 'published' }),
      row({ slug: 'draft', status: 'DRAFT' }),
      row({ slug: 'disabled', status: 'DISABLED' }),
    ]);
    expect(skills.map((skill) => skill.slug)).toEqual(['published']);
  });

  it('delivers only the highest version of a duplicated slug', () => {
    const skills = selectDeliverableSkills([
      row({ slug: 'review', version: '1.2.0', content: 'new' }),
      row({ slug: 'review', version: '1.9.0', content: 'old but higher' }),
      row({ slug: 'review', version: '1.10.0', content: 'newest' }),
    ]);
    expect(skills).toHaveLength(1);
    expect(skills[0]!.version).toBe('1.10.0');
    expect(skills[0]!.content).toBe('newest');
  });

  it('does not let a higher DRAFT version shadow a published one', () => {
    const skills = selectDeliverableSkills([
      row({ slug: 'review', version: '1.0.0' }),
      row({ slug: 'review', version: '2.0.0', status: 'DRAFT' }),
    ]);
    expect(skills[0]!.version).toBe('1.0.0');
  });

  it('gives PROMPT skills a prompt name and leaves SCRIPT skills resource-only', () => {
    const skills = selectDeliverableSkills([
      row({ slug: 'prompt-skill', kind: 'PROMPT' }),
      row({ slug: 'script-skill', kind: 'SCRIPT' }),
    ]);
    const prompt = skills.find((skill) => skill.slug === 'prompt-skill')!;
    const script = skills.find((skill) => skill.slug === 'script-skill')!;
    expect(prompt.promptName).toBe('skill-prompt-skill');
    expect(script.promptName).toBeNull();
    // Both are still readable as resources: the distinction is about invocation, not access.
    expect(script.resourceUri).toBe('localehub://skills/script-skill');
  });

  it('withholds a prompt name that a server already registers itself', () => {
    // Defence in depth behind the `skill-` prefix: if a built-in prompt ever took a `skill-`
    // name, the skill must give way rather than the server throwing on a duplicate registration.
    const skills = selectDeliverableSkills([row({ slug: 'sync' })], { reservedPromptNames: ['skill-sync'] });
    expect(skills[0]!.promptName).toBeNull();
    expect(skills[0]!.resourceUri).toBe('localehub://skills/sync');
  });

  it('sorts by slug so the index and the resource list are stable', () => {
    const skills = selectDeliverableSkills([row({ slug: 'zeta' }), row({ slug: 'alpha' })]);
    expect(skills.map((skill) => skill.slug)).toEqual(['alpha', 'zeta']);
  });
});

describe('skillBody', () => {
  it('strips the YAML frontmatter', () => {
    const content = '---\nname: review\nversion: 1.0.0\n---\n# Review\n\nDo the thing.';
    expect(skillBody(content)).toBe('# Review\n\nDo the thing.');
  });

  it('returns content without frontmatter unchanged', () => {
    expect(skillBody('# Plain\n\ntext')).toBe('# Plain\n\ntext');
  });

  it('does not mangle a document that opens with a horizontal rule', () => {
    // `---` is also a valid markdown rule. Without a closing fence this must be left alone.
    expect(skillBody('---\n\njust a rule')).toBe('---\n\njust a rule');
  });
});

describe('renderSkillIndex', () => {
  it('lists every skill with its resource and prompt', () => {
    const skills = selectDeliverableSkills([
      row({ slug: 'translation-review', name: '译文审核' }),
      row({ slug: 'localization-sync', name: '同步', kind: 'SCRIPT' }),
    ]);
    const text = renderSkillIndex(skills);
    expect(text).toContain('`localehub://skills/translation-review`');
    expect(text).toContain('`skill-translation-review`');
    expect(text).toContain('`localehub://skills/localization-sync`');
    expect(text).toContain('译文审核');
  });

  it('explains the empty case rather than rendering a table header alone', () => {
    const text = renderSkillIndex([]);
    expect(text).toContain('没有已发布的 Skill');
    expect(text).not.toContain('| Slug |');
  });
});
