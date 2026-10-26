import { run, which } from './system.js';

/**
 * Real agent: runs the user's local Claude Code CLI in non-interactive mode with the repository
 * (or the app sources) as working directory. Output is streamed as events; the final text is
 * returned. Tools are limited to git/file operations inside the working directory.
 */

export interface AgentRunOptions {
  prompt: string;
  cwd: string;
  mode: 'repo' | 'app';
  model?: string;
  cliPath?: string;
  /** edits are auto-accepted inside cwd; when false the agent only plans */
  apply?: boolean;
  /** a Claude Code session to continue (the previous answer in the same chat, same folder) */
  resume?: string;
  /** extra environment: the repository's connection (SSH key, account) for the git commands the agent runs */
  env?: Record<string, string>;
  /** that connection in words ("SSH key plrx"), for the agent to know what git signs in with */
  connection?: string;
  onEvent: (e: { type: 'text' | 'tool' | 'status'; text: string }) => void;
  /** aborting stops the Claude Code process */
  signal?: AbortSignal;
}

export async function checkClaude(cliPath?: string): Promise<{ ok: boolean; path: string | null; version: string }> {
  const p = cliPath && cliPath.trim() ? cliPath.trim() : await which('claude');
  if (!p) return { ok: false, path: null, version: '' };
  const r = await run(p, ['--version']).catch(() => ({ code: 1, stdout: '', stderr: '' }));
  return { ok: r.code === 0, path: p, version: r.stdout.trim() };
}

// Each target only learns about the other one: a request that belongs here is always done here.
const TO_APP = `If the request is about Prong itself (how the client looks or behaves: sidebar, toolbar, panels, colours, defaults, dialogs) rather than about this repository, do not run any tool and do not explain: reply with exactly the line "PRONG_TARGET: app"; Prong then re-runs it on its own sources.`;
const TO_REPO = `You are already in the right place for changes to Prong's interface or behaviour: make them here. Only if the request is plain git work in the user's repository (branches, commits, rebase, push…) and has nothing to do with Prong's own code, do not run any tool and reply with exactly the line "PRONG_TARGET: repo".`;
/** how answers look: Prong renders them as Markdown in a narrow chat column */
const FORMAT = `Format the reply as Markdown for a narrow chat panel: first one bold line with the outcome, then short bullets or numbered steps; branch names, paths and short commands in \`code\`; commands for the user to run in a \`\`\`sh block; at most "###" headings; no tables wider than three columns; no closing pleasantries. Keep it short unless asked for detail.`;
/** what the agent is told about the repository's connection (Prong already put it into git's environment) */
const connectionNote = (describe: string) =>
  `Prong's connection for this repository (and its submodules): ${describe}. It is already in the environment of every git command you run (GIT_SSH_COMMAND for an SSH key, a credential helper for an account), so fetch, pull, push, ls-remote and submodule update sign in with it; do not pass other keys. Check the connection with \`git ls-remote <remote> HEAD\`: plain \`ssh\` does not use it.`;
const SYSTEM_REPO = `You are the agent inside Prong, a git client. The working directory is the user's repository. Execute the user's request with git and shell commands; git's network commands already use the connection (SSH key or account) set for this repository in Prong. Prefer safe, reversible commands; never force-push or rewrite shared history unless explicitly asked. Reply in the user's language with what you did (commands run, resulting branch/commit). ${FORMAT} ${TO_APP}`;
const SYSTEM_APP = `You are the agent inside Prong, a git client that ships its own sources. The working directory is the app's source tree (Expo / React Native, TypeScript): src/components (Toolbar with the tab bar and its global buttons, Sidebar, CommitList, DiffView, dialogs), src/screens (Welcome = the home screen, Repository), src/state/store.ts (state and defaults), src/theme (visual system). Implement the user's request by editing the sources; keep the existing visual system and conventions. After editing, run "npx tsc --noEmit" and fix type errors. Prong commits your edits as a version and rebuilds its interface itself: do not commit, build or start anything. Reply in the user's language: which files changed and what to expect in the UI. ${FORMAT} ${TO_REPO}`;

export async function runAgent(o: AgentRunOptions): Promise<{ ok: boolean; text: string; costUsd?: number; sessionId?: string }> {
  const check = await checkClaude(o.cliPath);
  if (!check.ok || !check.path) throw new Error('Claude Code CLI not found. Install it or set the path in Agent → Settings.');
  const system = o.mode === 'app' ? SYSTEM_APP : o.connection ? `${SYSTEM_REPO} ${connectionNote(o.connection)}` : SYSTEM_REPO;
  const args = ['-p', o.prompt, '--output-format', 'stream-json', '--verbose', '--append-system-prompt', system];
  if (o.resume && /^[\w-]{8,64}$/.test(o.resume)) args.push('--resume', o.resume);
  if (o.model) args.push('--model', o.model);
  if (o.apply !== false) args.push('--permission-mode', 'acceptEdits');
  // tools: git, the usual file tools and a few read-only looks (folders, whether SSH gets in); everything else
  // needs the user's terminal
  args.push('--allowedTools', o.mode === 'app' ? 'Bash(npx tsc *),Bash(npm test*),Bash(git *),Read,Edit,Write,Glob,Grep' : 'Bash(git *),Bash(ls *),Bash(ssh-add -l*),Read,Glob,Grep');
  let finalText = '';
  let ok = false;
  let costUsd: number | undefined;
  let sessionId: string | undefined;
  const r = await run(check.path, args, {
    signal: o.signal,
    cwd: o.cwd,
    env: { ...(o.env ?? {}), CLAUDECODE: '', CLAUDE_CODE_ENTRYPOINT: 'prong' },
    onLine: (line) => {
      let ev: any;
      try {
        ev = JSON.parse(line);
      } catch {
        o.onEvent({ type: 'status', text: line });
        return;
      }
      if (ev.type === 'system' && ev.subtype === 'init') {
        sessionId = ev.session_id;
        o.onEvent({ type: 'status', text: `session ${String(ev.session_id ?? '').slice(0, 8)} · ${ev.model ?? ''}` });
      } else if (ev.type === 'assistant' && ev.message?.content) {
        for (const c of ev.message.content) {
          if (c.type === 'text' && c.text) o.onEvent({ type: 'text', text: c.text });
          if (c.type === 'tool_use') o.onEvent({ type: 'tool', text: `${c.name} ${summarizeInput(c.input)}` });
        }
      } else if (ev.type === 'result') {
        ok = ev.subtype === 'success';
        finalText = ev.result ?? '';
        costUsd = ev.total_cost_usd;
      }
    },
  });
  if (o.signal?.aborted) throw new Error('Stopped');
  if (!finalText && r.code !== 0) throw new Error(r.stderr.trim().split('\n').slice(-3).join(' ') || `claude exited with ${r.code}`);
  return { ok: ok || r.code === 0, text: finalText, costUsd, sessionId };
}

function summarizeInput(input: any): string {
  if (!input) return '';
  if (typeof input.command === 'string') return input.command.slice(0, 140);
  if (typeof input.file_path === 'string') return input.file_path;
  if (typeof input.pattern === 'string') return input.pattern;
  return JSON.stringify(input).slice(0, 100);
}
