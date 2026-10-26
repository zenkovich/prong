import type { SavedSession } from './types.js';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/** Small JSON documents persisted under ~/.prong (repos, workspaces, settings). */
export const STATE_DIR = () => process.env.PRONG_STATE_DIR ?? path.join(homedir(), '.prong');

export function readJson<T>(name: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path.join(STATE_DIR(), name), 'utf8')) as T;
  } catch {
    return fallback;
  }
}
export function writeJson(name: string, value: unknown) {
  mkdirSync(STATE_DIR(), { recursive: true });
  writeFileSync(path.join(STATE_DIR(), name), JSON.stringify(value, null, 2));
}

export interface Workspace {
  id: string;
  name: string;
  /** folder scanned for repositories; optional */
  rootPath?: string;
  scanDepth?: number;
}

export interface Settings {
  editor: string; // app name for `open -a`
  terminal: string;
  diffTool: string;
  pullMode: 'merge' | 'rebase' | 'ff';
  /** after a checkout, pull, merge… the submodules whose recorded commit changed follow it (git submodule update) */
  autoUpdateSubmodules: boolean;
  signCommits: boolean;
  agent: {
    provider: 'anthropic-claude-code' | 'anthropic-api' | 'openai-compatible';
    model: string;
    cliPath: string;
    sourcesPath: string;
    askBeforeApply: boolean;
    autoRollbackOnBuildError: boolean;
  };
  githubClientId: string;
  /** author avatars from GitHub / Gravatar (cached on disk) */
  avatars: boolean;
  /** interface preferences the app persists across launches */
  ui: UiSettings;
}

export interface UiSettings {
  theme: string;
  uiScale: number;
  fileView: 'list' | 'tree';
  diffMode: 'unified' | 'split';
  sidebarWidth: number;
  submoduleView: 'list' | 'tree';
  /** what the commit button does: commit, or commit and push */
  commitAction: 'commit' | 'commit-push';
  /** heights of the resizable commit box (Changes) and commit description block (history), and whether the
   * description parts are unfolded */
  commitBoxHeight: number;
  commitDescOpen: boolean;
  detailsHeaderHeight: number;
  detailsDescOpen: boolean;
}

export const DEFAULT_UI: UiSettings = { theme: 'amber', uiScale: 1, fileView: 'tree', diffMode: 'unified', sidebarWidth: 230, submoduleView: 'tree', commitAction: 'commit', commitBoxHeight: 170, commitDescOpen: true, detailsHeaderHeight: 130, detailsDescOpen: true };

export const DEFAULT_SETTINGS: Settings = {
  editor: 'Visual Studio Code',
  terminal: 'Terminal',
  diffTool: '',
  pullMode: 'rebase',
  autoUpdateSubmodules: true,
  signCommits: false,
  agent: { provider: 'anthropic-claude-code', model: '', cliPath: '', sourcesPath: '', askBeforeApply: false, autoRollbackOnBuildError: true },
  githubClientId: '',
  avatars: true,
  ui: DEFAULT_UI,
};

export const loadWorkspaces = () => readJson<Workspace[]>('workspaces.json', [{ id: 'work', name: 'work' }, { id: 'home', name: 'home' }]);
export const saveWorkspaces = (w: Workspace[]) => writeJson('workspaces.json', w);
/** tabs and branch filters across launches (see SavedSession) */
export const loadSession = () => readJson<SavedSession>('session.json', {});
export const saveSession = (s: SavedSession) => writeJson('session.json', s);
export const loadSettings = (): Settings => {
  const stored = readJson<Partial<Settings>>('settings.json', {});
  const agent = { ...DEFAULT_SETTINGS.agent, ...(stored.agent ?? {}) };
  const ui = { ...DEFAULT_UI, ...(stored.ui ?? {}) };
  // when running from the source tree the app sources are the project itself
  if (!agent.sourcesPath && process.env.PRONG_SOURCES_DEFAULT) agent.sourcesPath = process.env.PRONG_SOURCES_DEFAULT;
  return { ...DEFAULT_SETTINGS, ...stored, agent, ui };
};
export const saveSettings = (s: Settings) => writeJson('settings.json', s);
