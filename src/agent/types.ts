/**
 * The agent concept: the app ships with its own sources, bundled at runtime (dev-server style).
 * A local agent (Anthropic model through the user's Claude Code CLI) edits those sources on request.
 * Every edit is a versioned change that can be reverted, rolled back or reset to the factory build.
 *
 * In the prototype the "sources" are a set of runtime modifiers (`AppMods`) applied by a mock agent.
 */

export type AgentTarget = 'auto' | 'repo' | 'app';

export interface AgentMessage {
  id: number;
  role: 'user' | 'agent' | 'system';
  text: string;
  time: number;
  /** actions the agent performed (repo commands, file edits) */
  actions?: string[];
  /** version created by this message (app changes) */
  versionId?: number;
  target?: 'repo' | 'app';
}

export interface AppMods {
  hideAuthor: boolean;
  compactToolbar: boolean;
  hiddenToolbarButtons: string[];
  extraToolbarButtons: string[];
  absoluteDates: boolean;
  graphWidth: number;
  sidebarWidth: number | null;
  scheme: string | null;
  rowHeight: number | null;
  statusMode: boolean;
}

export const FACTORY_MODS: AppMods = {
  hideAuthor: false,
  compactToolbar: false,
  hiddenToolbarButtons: [],
  extraToolbarButtons: [],
  absoluteDates: false,
  graphWidth: 1.5,
  sidebarWidth: null,
  scheme: null,
  rowHeight: null,
  statusMode: true,
};

export interface AppVersion {
  id: number;
  n: number; // v1, v2 …
  title: string;
  prompt: string;
  time: number;
  files: string[];
  diff: string; // short unified-diff excerpt shown in the log
  patch: Partial<AppMods>;
  status: 'applied' | 'reverted';
  build: 'ok' | 'failed';
  /** real versions: commit in the sources repository and the commit that reverted it */
  sha?: string;
  revertSha?: string;
  sourcesPath?: string;
}

export interface AgentSettings {
  provider: 'anthropic-claude-code' | 'anthropic-api' | 'openai-compatible';
  model: string;
  cliPath: string;
  sourcesPath: string;
  askBeforeApply: boolean;
  autoRollbackOnBuildError: boolean;
  connected: boolean;
  cliVersion: string;
}
