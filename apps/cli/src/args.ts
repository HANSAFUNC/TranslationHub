export interface ParsedArgs {
  command: string[];
  flags: Record<string, string | boolean>;
  positionals: string[];
}

/** Commands that take a sub-action (`localehub sync preview`). */
const GROUP_COMMANDS = new Set(['sync', 'apply', 'release']);

/**
 * Minimal argv parser: `--flag`, `--key=value`, `--key value`, `-f`.
 * Non-flag arguments become positionals; the first one (plus the sub-action for group commands)
 * forms the command, the rest are positional arguments.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const words: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg.startsWith('--')) {
      const [key, inline] = arg.slice(2).split('=');
      if (inline !== undefined) {
        flags[key as string] = inline;
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('-')) {
          flags[key as string] = next;
          i += 1;
        } else {
          flags[key as string] = true;
        }
      }
    } else if (arg.startsWith('-') && arg.length > 1) {
      flags[arg.slice(1)] = true;
    } else {
      words.push(arg);
    }
  }

  const [first, second, ...rest] = words;
  const command: string[] = [];
  const positionals: string[] = [];
  if (first) {
    command.push(first);
    if (GROUP_COMMANDS.has(first) && second) {
      command.push(second);
      positionals.push(...rest);
    } else if (second) {
      positionals.push(second, ...rest);
    }
  }

  return { command, flags, positionals };
}

export function flagBool(flags: Record<string, string | boolean>, key: string): boolean {
  const value = flags[key];
  return value === true || value === 'true' || value === '1';
}
