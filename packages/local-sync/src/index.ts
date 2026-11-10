/**
 * Local repository engine.
 *
 * Scanning, three-way sync planning, safe write-back and the workspace guard. It has no transport
 * and no MCP dependency: the CLI drives it (`localehub scan`, `localehub sync preview`, …), and the
 * platform exposes exactly one MCP — the remote one, which cannot reach a developer's disk.
 */
export * from './services';
export * from './state';
export * from './apply';
export * from './scan';
