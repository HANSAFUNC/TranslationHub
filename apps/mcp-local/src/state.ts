import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ApplyPlan } from '@localehub/sync-engine';

/**
 * Local MCP state, persisted inside the workspace at `.localehub/state.json`.
 *
 * It holds only identifiers and hashes — never tokens, never translation payloads beyond the
 * pending apply plans the user has explicitly previewed. Everything here is safe to delete.
 */
export interface LocalState {
  version: 1;
  projectId: string | null;
  connectionId: string | null;
  lastScanId: string | null;
  lastScanAt: string | null;
  lastRevision: number | null;
  lastPreview: {
    syncPlanId: string;
    planHash: string;
    sessionId: string;
    expiresAt: string;
    summary: Record<string, number>;
    createdAt: string;
  } | null;
  pendingApplyPlans: ApplyPlan[];
  lastApplyReport: {
    applyPlanId: string;
    status: string;
    files: string[];
    appliedAt: string;
    gitCommit: string | null;
  } | null;
  history: { at: string; action: string; detail: string }[];
}

const EMPTY: LocalState = {
  version: 1,
  projectId: null,
  connectionId: null,
  lastScanId: null,
  lastScanAt: null,
  lastRevision: null,
  lastPreview: null,
  pendingApplyPlans: [],
  lastApplyReport: null,
  history: [],
};

export class StateStore {
  private state: LocalState;
  private readonly file: string;

  constructor(private readonly workspaceRoot: string) {
    this.file = join(workspaceRoot, '.localehub', 'state.json');
    this.state = this.load();
  }

  private load(): LocalState {
    if (!existsSync(this.file)) return { ...EMPTY };
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as LocalState;
      return { ...EMPTY, ...parsed, pendingApplyPlans: parsed.pendingApplyPlans ?? [] };
    } catch {
      return { ...EMPTY };
    }
  }

  get(): LocalState {
    return this.state;
  }

  patch(update: Partial<LocalState>): LocalState {
    this.state = { ...this.state, ...update };
    this.persist();
    return this.state;
  }

  record(action: string, detail: string): void {
    this.state.history = [{ at: new Date().toISOString(), action, detail }, ...this.state.history].slice(0, 100);
    this.persist();
  }

  storeApplyPlan(plan: ApplyPlan): void {
    this.state.pendingApplyPlans = [plan, ...this.state.pendingApplyPlans.filter((item) => item.applyPlanId !== plan.applyPlanId)].slice(0, 20);
    this.persist();
  }

  getApplyPlan(applyPlanId: string): ApplyPlan | null {
    return this.state.pendingApplyPlans.find((plan) => plan.applyPlanId === applyPlanId) ?? null;
  }

  clearApplyPlan(applyPlanId: string): void {
    this.state.pendingApplyPlans = this.state.pendingApplyPlans.filter((plan) => plan.applyPlanId !== applyPlanId);
    this.persist();
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
  }

  /** Directory for backups and patches produced by the MCP. */
  artifactDir(kind: 'backups' | 'patches' | 'reports'): string {
    const dir = join(this.workspaceRoot, '.localehub', kind);
    mkdirSync(dir, { recursive: true });
    return dir;
  }
}
