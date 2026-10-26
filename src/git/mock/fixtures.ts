import {
  Commit,
  DiffLine,
  FileChange,
  GitHubAccount,
  Hunk,
  Ref,
  Remote,
  RepoInfo,
  RepoSnapshot,
  SshKey,
  Stash,
  Workspace,
} from '../types';

// ---------- helpers ----------

const HEX = '0123456789abcdef';
export function fakeSha(seed: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < seed.length; i++) {
    h1 ^= seed.charCodeAt(i);
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 = (h2 + seed.charCodeAt(i) * 31) >>> 0;
  }
  let out = '';
  let x = h1;
  let y = h2;
  for (let i = 0; i < 40; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    y = (Math.imul(y, 22695477) + 1) >>> 0;
    out += HEX[((x >>> 16) ^ (y >>> 8)) & 15];
  }
  return out;
}

let hunkCounter = 0;
function hunk(oldStart: number, newStart: number, fn: string, spec: string): Hunk {
  // spec: lines prefixed with ' ', '+', '-'
  const lines: DiffLine[] = [];
  let o = oldStart;
  let n = newStart;
  let oldCount = 0;
  let newCount = 0;
  for (const raw of spec.split('\n')) {
    if (!raw.length) continue;
    const p = raw[0];
    const text = raw.slice(1);
    if (p === '+') {
      lines.push({ kind: 'add', newNo: n++, text });
      newCount++;
    } else if (p === '-') {
      lines.push({ kind: 'del', oldNo: o++, text });
      oldCount++;
    } else {
      lines.push({ kind: 'ctx', oldNo: o++, newNo: n++, text });
      oldCount++;
      newCount++;
    }
  }
  return {
    id: `h${++hunkCounter}`,
    header: `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@${fn ? ' ' + fn : ''}`,
    lines,
  };
}

function textFile(path: string, status: FileChange['status'], hunks: Hunk[], extra: Partial<FileChange> = {}): FileChange {
  let additions = 0;
  let deletions = 0;
  for (const h of hunks)
    for (const l of h.lines) {
      if (l.kind === 'add') additions++;
      if (l.kind === 'del') deletions++;
    }
  return { path, status, kind: 'text', additions, deletions, hunks, ...extra };
}

export function cloneFile(f: FileChange): FileChange {
  return {
    ...f,
    hunks: f.hunks?.map((h) => ({ ...h, lines: h.lines.map((l) => ({ ...l })) })),
  };
}

// ---------- canned diffs ----------

export const DIFF_DIFFVIEW = () =>
  textFile('src/components/DiffView.tsx', 'M', [
    hunk(
      12,
      12,
      'export function DiffView({ file }: Props) {',
      ` const theme = useTheme();
 const [mode, setMode] = useState<'unified' | 'split'>('unified');
-const lines = useMemo(() => flatten(file.hunks), [file]);
+const lines = useMemo(() => flatten(file.hunks ?? []), [file]);
+const wordDiff = useWordDiff(lines);

 if (file.kind === 'image') {
   return <ImageDiff file={file} />;
 }`,
    ),
    hunk(
      58,
      59,
      'function HunkHeader({ hunk }: { hunk: Hunk }) {',
      ` return (
   <View style={[styles.hunkHeader, { backgroundColor: theme.panelAlt }]}>
-    <Text style={styles.hunkText}>{hunk.header}</Text>
+    <Text style={[styles.hunkText, { color: theme.info, fontFamily: theme.mono }]}>
+      {hunk.header}
+    </Text>
+    <StageHunkButton hunk={hunk} />
   </View>
 );
}`,
    ),
  ]);

export const DIFF_FIXTURES = () =>
  textFile('src/git/mock/fixtures.ts', 'M', [
    hunk(
      3,
      3,
      '',
      ` import { Commit, FileChange } from '../types';

-const AUTHORS = ['Andrei', 'Maria'];
+const AUTHORS = ['Andrei Zenkovich', 'Maria Petrova', 'dependabot[bot]'];
+const EMAILS = AUTHORS.map((a) => a.toLowerCase().replace(/[^a-z]/g, '') + '@example.com');

 export function buildHistory(): Commit[] {`,
    ),
  ]);

export const DIFF_THEME = () =>
  textFile('src/theme/index.ts', 'M', [
    hunk(
      40,
      40,
      'export const darkTheme: Theme = {',
      `   accent: '#4c8dff',
-  accentSoft: 'rgba(76,141,255,0.12)',
+  accentSoft: 'rgba(76,141,255,0.18)',
+  selection: 'rgba(76,141,255,0.28)',
   hover: 'rgba(255,255,255,0.05)',`,
    ),
  ]);

export const DIFF_PACKAGE = () =>
  textFile('package.json', 'M', [
    hunk(
      8,
      8,
      '',
      `     "react-native": "0.88.0",
+    "react-native-svg": "15.16.0",
+    "react-native-web": "^0.21.4",
     "expo-status-bar": "~58.0.3"`,
    ),
  ]);

export const DIFF_DESIGN_DOC = () =>
  textFile('docs/DESIGN.md', 'A', [
    hunk(
      0,
      1,
      '',
      `+# Prong — функциональный дизайн
+
+Кроссплатформенный git-клиент в духе Fork.
+
+## 1. Цели
+
+- Повторить рабочую модель Fork
+- Один код UI для macOS, Windows, Linux
+- Быстрый отклик на больших репозиториях`,
    ),
  ]);

export const DIFF_LEGACY = () =>
  textFile('src/old/LegacyGraph.ts', 'D', [
    hunk(
      1,
      0,
      '',
      `-export function drawGraph(ctx: CanvasRenderingContext2D) {
-  // old canvas renderer, replaced by SVG lanes
-  ctx.strokeStyle = '#888';
-  ctx.lineWidth = 2;
-}`,
    ),
  ]);

export const DIFF_RENAME = () =>
  textFile(
    'docs/README.md',
    'R',
    [
      hunk(
        1,
        1,
        '',
        ` # Prong

-Git client prototype.
+Git client prototype. See docs/DESIGN.md for the functional design.`,
      ),
    ],
    { oldPath: 'README.md', similarity: 92 },
  );

export const DIFF_IMAGE = (): FileChange => ({
  path: 'assets/logo.png',
  status: 'M',
  kind: 'image',
  additions: 0,
  deletions: 0,
  image: { before: '#6c5ce7', after: '#4c8dff', beforeSize: '512×512 · 38 KB', afterSize: '1024×1024 · 71 KB' },
});

export const DIFF_IMAGE_NEW = (): FileChange => ({
  path: 'assets/icons/rebase.png',
  status: 'A',
  kind: 'image',
  additions: 0,
  deletions: 0,
  image: { after: '#3fb950', afterSize: '64×64 · 2 KB' },
});

export const DIFF_BINARY = (): FileChange => ({
  path: 'bin/prong-helper',
  status: 'M',
  kind: 'binary',
  additions: 0,
  deletions: 0,
  binary: { beforeBytes: 1_284_552, afterBytes: 1_301_908 },
});

export const DIFF_SUBMODULE = (): FileChange => ({
  path: 'vendor/libgit2',
  status: 'M',
  kind: 'submodule',
  additions: 0,
  deletions: 0,
  submodule: { before: fakeSha('sub-before'), after: fakeSha('sub-after') },
});

export const DIFF_LARGE = (): FileChange => ({
  path: 'data/commit-benchmark.csv',
  status: 'M',
  kind: 'large',
  additions: 48_120,
  deletions: 47_990,
});

export const DIFF_CONFLICT = (): FileChange => ({
  path: 'src/components/MergeBar.tsx',
  status: 'U',
  kind: 'text',
  additions: 4,
  deletions: 2,
  conflict: {
    base: ['export function MergeBar() {', "  return <Bar label='Merge' />;", '}'],
    ours: ['export function MergeBar({ onAbort }: Props) {', "  return <Bar label='Merge in progress' onAbort={onAbort} />;", '}'],
    theirs: ['export function MergeBar({ state }: Props) {', "  return <Bar label={`Merging ${state.branch}`} />;", '}'],
  },
  hunks: [
    hunk(
      1,
      1,
      '',
      ` import { Bar } from './Bar';

-export function MergeBar() {
-  return <Bar label='Merge' />;
+<<<<<<< HEAD
+export function MergeBar({ onAbort }: Props) {
+  return <Bar label='Merge in progress' onAbort={onAbort} />;
+=======
+export function MergeBar({ state }: Props) {
+  return <Bar label={\`Merging \${state.branch}\`} />;
+>>>>>>> feature/merge-state
 }`,
    ),
  ],
});

const GENERIC_FILES: (() => FileChange)[] = [
  DIFF_DIFFVIEW,
  DIFF_FIXTURES,
  DIFF_THEME,
  DIFF_PACKAGE,
  DIFF_RENAME,
  DIFF_IMAGE,
  DIFF_BINARY,
  () =>
    textFile('src/components/Sidebar.tsx', 'M', [
      hunk(
        20,
        20,
        'export function Sidebar() {',
        `   const repo = useRepo();
-  const branches = repo.refs.filter((r) => r.kind === 'branch');
+  const branches = useMemo(() => repo.refs.filter((r) => r.kind === 'branch'), [repo.refs]);
+  const tree = useMemo(() => groupBySlash(branches), [branches]);`,
      ),
    ]),
  () =>
    textFile('src/git/process/parseLog.ts', 'A', [
      hunk(
        0,
        1,
        '',
        `+const SEP = '\\x1f';
+export function parseLog(out: string): Commit[] {
+  return out
+    .split('\\x1e')
+    .filter(Boolean)
+    .map((rec) => {
+      const [sha, parents, author, email, date, subject, body] = rec.split(SEP);
+      return { sha, parents: parents.split(' ').filter(Boolean), author, email, date: +date * 1000, subject, body };
+    });
+}`,
      ),
    ]),
  () =>
    textFile('src/state/repoStore.ts', 'M', [
      hunk(
        88,
        88,
        'stageFile(path) {',
        `   const file = s.unstaged.find((f) => f.path === path);
   if (!file) return;
-  s.staged.push(file);
+  s.staged = [...s.staged, file].sort(byPath);
   s.unstaged = s.unstaged.filter((f) => f !== file);`,
      ),
    ]),
];

// ---------- history ----------

interface Spec {
  key: string;
  parents: string[];
  subject: string;
  body?: string;
  author?: string;
  minutes: number; // minutes ago
  files?: number[]; // indexes into GENERIC_FILES
}

const AUTHORS: Record<string, { name: string; email: string }> = {
  az: { name: 'Andrei Zenkovich', email: 'andrei@zenkovich.space' },
  mp: { name: 'Maria Petrova', email: 'maria@example.com' },
  bot: { name: 'dependabot[bot]', email: 'support@github.com' },
  jk: { name: 'Jonas Kahl', email: 'jonas@example.com' },
};

const H = 60;
const D = 24 * H;

const SPECS: Spec[] = [
  // current branch feature/rebase-ui
  { key: 'r5', parents: ['r4'], subject: 'Interactive rebase: drag rows to reorder, squash/fixup actions', minutes: 25, files: [0, 7, 9] },
  { key: 'r4', parents: ['r3'], subject: 'Rebase dialog: onto picker with branch search', minutes: 3 * H, files: [7, 2] },
  { key: 'r3', parents: ['r2'], subject: 'Wire GIT_SEQUENCE_EDITOR bridge for rebase todo', minutes: 1 * D + 2 * H, files: [8], body: 'The sequence editor is a tiny script that writes the todo list\nproduced by the UI. Works with both rebase -i and rebase --exec.' },
  { key: 'r2', parents: ['r1'], subject: 'Add RebaseTodo model and reducer', minutes: 1 * D + 5 * H, files: [9] },
  { key: 'r1', parents: ['c24'], subject: 'Scaffold rebase UI feature flag', minutes: 2 * D, files: [3] },
  // origin/main moved ahead by a colleague
  { key: 'c25', parents: ['c24'], subject: 'CI: run typecheck on pull requests', minutes: 1 * D + 1 * H, author: 'mp', files: [3] },
  { key: 'c24', parents: ['c23'], subject: 'Bump react-native-svg to 15.16.0', minutes: 2 * D + 3 * H, author: 'bot', files: [3] },
  { key: 'c23', parents: ['m2'], subject: 'Status bar: show ahead/behind for current branch', minutes: 3 * D, files: [7] },
  { key: 'm2', parents: ['c22', 'x2'], subject: "Merge branch 'fix/crash-on-clone'", minutes: 4 * D, files: [] },
  { key: 'x2', parents: ['x1'], subject: 'Clone: handle progress lines without trailing newline', minutes: 4 * D + 2 * H, author: 'mp', files: [8] },
  { key: 'x1', parents: ['c21'], subject: 'Clone: guard against empty stderr chunks', minutes: 4 * D + 6 * H, author: 'mp', files: [8] },
  { key: 'c22', parents: ['c21'], subject: 'Toolbar: pull strategy menu (merge / rebase / ff-only)', minutes: 4 * D + 4 * H, files: [7] },
  { key: 'c21', parents: ['c20'], subject: 'Settings: per-repo identity override', minutes: 5 * D, files: [9, 2] },
  { key: 'e2', parents: ['e1'], subject: 'wasm-git: expose log() through worker', minutes: 5 * D + 3 * H, author: 'jk', files: [8] },
  { key: 'e1', parents: ['c20'], subject: 'Spike: libgit2 compiled to wasm', minutes: 6 * D, author: 'jk', files: [6] },
  { key: 'c20', parents: ['m1'], subject: 'Light theme polish, fix contrast of muted text', minutes: 6 * D + 2 * H, files: [2] },
  { key: 'm1', parents: ['c19', 'f4'], subject: "Merge branch 'feature/diff-view'", minutes: 7 * D, files: [] },
  { key: 'f4', parents: ['f3'], subject: 'Diff: word-level highlighting inside changed lines', minutes: 7 * D + 2 * H, files: [0] },
  { key: 'f3', parents: ['f2'], subject: 'Diff: image before/after with slider', minutes: 8 * D, files: [0, 5] },
  { key: 'f2', parents: ['f1'], subject: 'Diff: stage/unstage single hunk', minutes: 9 * D, files: [0, 9] },
  { key: 'f1', parents: ['c15'], subject: 'Diff view skeleton with unified mode', minutes: 11 * D, files: [0] },
  { key: 'c19', parents: ['c18'], subject: 'Commit list: virtualize rows', minutes: 8 * D + 5 * H, files: [7] },
  { key: 'c18', parents: ['c17'], subject: 'Graph: lane allocation for merges', minutes: 9 * D + 1 * H, files: [7] },
  { key: 'c17', parents: ['c16'], subject: 'Sidebar: group branches by slash', minutes: 10 * D, files: [7] },
  { key: 'c16', parents: ['c15'], subject: 'Welcome screen with recent repositories', minutes: 10 * D + 4 * H, files: [1] },
  { key: 'c15', parents: ['c14'], subject: 'Add mock git client with fixtures', minutes: 12 * D, files: [1] },
];

const OLDER_SUBJECTS = [
  'Theme tokens and dark palette',
  'Keyboard shortcuts for fetch/pull/push',
  'Add status parsing for porcelain v2',
  'ProcessRunner native module interface',
  'Expo web target and metro config',
  'Lint and typecheck scripts',
  'Project scaffold',
  'Add LICENSE',
  'Initial commit',
];

export function buildHistory(): { commits: Commit[]; byKey: Record<string, string> } {
  const specs = [...SPECS];
  let prev = 'c14';
  const base = 13 * D;
  OLDER_SUBJECTS.forEach((subject, i) => {
    const key = prev;
    const parentKey = i === OLDER_SUBJECTS.length - 1 ? null : `c${14 - i - 1}`;
    specs.push({
      key,
      parents: parentKey ? [parentKey] : [],
      subject,
      minutes: base + i * D,
      author: i % 3 === 1 ? 'mp' : 'az',
      files: [i % GENERIC_FILES.length],
    });
    prev = parentKey ?? '';
  });
  const byKey: Record<string, string> = {};
  for (const s of specs) byKey[s.key] = fakeSha(s.key);
  const now = Date.now();
  const commits: Commit[] = specs.map((s) => {
    const a = AUTHORS[s.author ?? 'az'];
    return {
      sha: byKey[s.key],
      parents: s.parents.map((p) => byKey[p]),
      subject: s.subject,
      body: s.body ?? '',
      author: a.name,
      email: a.email,
      date: now - s.minutes * 60_000,
      files: (s.files ?? []).map((i) => GENERIC_FILES[i]()),
    };
  });
  return { commits, byKey };
}

export function buildSnapshot(): RepoSnapshot {
  const { commits, byKey } = buildHistory();
  const refs: Ref[] = [
    { name: 'feature/rebase-ui', kind: 'branch', sha: byKey.r5, current: true, upstream: 'origin/feature/rebase-ui', ahead: 2, behind: 0 },
    { name: 'main', kind: 'branch', sha: byKey.c24, upstream: 'origin/main', ahead: 0, behind: 1 },
    { name: 'experiment/wasm-git', kind: 'branch', sha: byKey.e2, upstream: 'origin/experiment/wasm-git', ahead: 0, behind: 0 },
    { name: 'fix/crash-on-clone', kind: 'branch', sha: byKey.x2 },
    { name: 'origin/feature/rebase-ui', kind: 'remote', sha: byKey.r3 },
    { name: 'origin/main', kind: 'remote', sha: byKey.c25 },
    { name: 'origin/experiment/wasm-git', kind: 'remote', sha: byKey.e2 },
    { name: 'origin/HEAD', kind: 'remote', sha: byKey.c25 },
    { name: 'v1.0.0', kind: 'tag', sha: byKey.m2 },
    { name: 'v0.9.0-rc1', kind: 'tag', sha: byKey.c19 },
  ];
  const remotes: Remote[] = [{ name: 'origin', url: 'git@github.com:zenkovich/prong.git' }];
  const stashes: Stash[] = [
    {
      index: 0,
      message: 'WIP on main: experiment with canvas graph',
      date: Date.now() - 3 * D,
      sha: fakeSha('stash0'),
      files: [DIFF_LEGACY(), DIFF_THEME()],
    },
  ];
  return {
    commits,
    refs,
    remotes,
    stashes,
    head: byKey.r5,
    unstaged: [
      DIFF_DIFFVIEW(),
      DIFF_FIXTURES(),
      DIFF_DESIGN_DOC(),
      DIFF_LEGACY(),
      DIFF_RENAME(),
      DIFF_IMAGE(),
      DIFF_IMAGE_NEW(),
      DIFF_BINARY(),
      DIFF_SUBMODULE(),
      DIFF_LARGE(),
      DIFF_CONFLICT(),
    ],
    staged: [DIFF_THEME(), DIFF_PACKAGE()],
  };
}

// Second, smaller repository for the tab switcher.
export function buildSmallSnapshot(): RepoSnapshot {
  const keys = ['s6', 's5', 's4', 's3', 's2', 's1'];
  const subjects = [
    'Render hub page from games.json',
    'Add potato_obby build',
    'Dockerfile: cache wasm toolchain layer',
    'Hub: card hover animation',
    'Add sahur game',
    'Initial hub',
  ];
  const now = Date.now();
  const commits: Commit[] = keys.map((k, i) => ({
    sha: fakeSha(k),
    parents: i < keys.length - 1 ? [fakeSha(keys[i + 1])] : [],
    subject: subjects[i],
    body: '',
    author: AUTHORS.az.name,
    email: AUTHORS.az.email,
    date: now - (i + 1) * 5 * H * 60_000,
    files: [GENERIC_FILES[(i + 3) % GENERIC_FILES.length]()],
  }));
  return {
    commits,
    refs: [
      { name: 'main', kind: 'branch', sha: fakeSha('s6'), current: true, upstream: 'origin/main', ahead: 1, behind: 0 },
      { name: 'origin/main', kind: 'remote', sha: fakeSha('s5') },
    ],
    remotes: [{ name: 'origin', url: 'https://github.com/zenkovich/games.git' }],
    stashes: [],
    head: fakeSha('s6'),
    unstaged: [DIFF_PACKAGE()],
    staged: [],
  };
}

export const WORKSPACES: Workspace[] = [
  { id: 'work', name: 'work' },
  { id: 'home', name: 'home' },
];

export const REPOS: RepoInfo[] = [
  { id: 'prong', name: 'prong', workspace: 'work', path: '~/work/zenkovich.space/prong', currentBranch: 'feature/rebase-ui', changes: 13, lastOpened: Date.now() - 20 * 60_000, pinned: true },
  { id: 'games', name: 'games', workspace: 'work', path: '~/work/zenkovich.space/games', currentBranch: 'main', changes: 1, lastOpened: Date.now() - 2 * D * 60_000 },
  { id: 'assetsline', name: 'AssetsLine', workspace: 'work', path: '~/work/zenkovich.space/AssetsLine', currentBranch: 'main', changes: 0, lastOpened: Date.now() - 3 * D * 60_000 },
  { id: 'o2portal', name: 'o2portal', workspace: 'work', path: '~/work/zenkovich.space/o2portal', currentBranch: 'main', changes: 0, lastOpened: Date.now() - 9 * D * 60_000 },
  { id: 'petstory', name: 'PetStory', workspace: 'home', path: '~/home/PetStory', currentBranch: 'develop', changes: 4, lastOpened: Date.now() - 14 * D * 60_000, pinned: true },
  { id: 'myhouse', name: 'myhouse', workspace: 'home', path: '~/home/myhouse', currentBranch: 'main', changes: 0, lastOpened: Date.now() - 5 * D * 60_000 },
  { id: 'dotfiles', name: 'dotfiles', workspace: 'home', path: '~/.dotfiles', currentBranch: 'main', changes: 2, lastOpened: Date.now() - 30 * D * 60_000 },
];

export const GITHUB_ACCOUNTS: GitHubAccount[] = [
  { id: 'gh1', login: 'zenkovich', host: 'github.com', name: 'Andrei Zenkovich', orgs: ['o2-engine'], avatarColor: '#4c8dff' },
];

export const GITHUB_REPOS = [
  'zenkovich/prong',
  'zenkovich/games',
  'zenkovich/remote_configs',
  'zenkovich/myhouse',
  'o2-engine/AssetsLine',
  'o2-engine/o2-Template',
  'o2-engine/o2portal',
  'o2-engine/PetStory',
  'o2-engine/AssetsLIneUnity',
];

export const SSH_KEYS: SshKey[] = [
  {
    id: 'k1',
    name: 'id_ed25519',
    type: 'ed25519',
    fingerprint: 'SHA256:q4Tn9bD3xKu2mN8fYw1Lc7PzRkHs0Vb5eGjA6tCiX2o',
    publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGx3rY0kQ5p2vM8aXcN1tLq7ZbFw9eHs4UjKd6yPoRiT andrei@mbp',
    inAgent: true,
    addedToGitHub: true,
    hasPassphrase: true,
  },
  {
    id: 'k2',
    name: 'id_rsa',
    type: 'rsa',
    fingerprint: 'SHA256:0mZ8eBv2Lw7XqRf3TtKc1NyJs6Pd9HaG4iUo5VbEnQk',
    publicKey: 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQC7... andrei@old-imac',
    inAgent: false,
    addedToGitHub: false,
    hasPassphrase: false,
  },
];
