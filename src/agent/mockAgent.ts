import { AgentTarget, AppMods } from './types';

/**
 * Mock agent: recognises a handful of Russian / English commands and turns them into either
 * repository actions (executed against the mock store) or app changes (a patch of AppMods with a
 * believable list of touched files and a diff excerpt). Anything else gets an honest explanation.
 */

export interface RepoPlan {
  kind: 'repo';
  actions: { label: string; run: string; arg?: string }[];
  reply: string;
}
export interface AppPlan {
  kind: 'app';
  title: string;
  patch: Partial<AppMods>;
  files: string[];
  diff: string;
  reply: string;
}
export interface HelpPlan {
  kind: 'help';
  reply: string;
}
export type Plan = RepoPlan | AppPlan | HelpPlan;

const RX = {
  branch: /(?:создай|сделай|создать|create|new)\s+(?:ветку|branch)\s+([\w./-]+)/i,
  checkout: /(?:переключи(?:сь)?|перейди|checkout|switch(?: to)?)\s+(?:на\s+|to\s+)?(?:ветку\s+|branch\s+)?([\w./-]+)/i,
  commit: /(?:закоммить|закоммит|commit)(?:\s+(?:всё|все|all))?(?:\s*[:—-]\s*|\s+with\s+message\s+|\s+)?["«]?([^"»]+)?["»]?$/i,
  push: /(?:^|[^a-zа-яё])(?:запушь|запуш|push)(?![a-zа-яё])/i,
  pull: /(?:^|[^a-zа-яё])(?:пулл|подтяни|pull)(?![a-zа-яё])/i,
  fetch: /(?:^|[^a-zа-яё])(?:фетч|fetch|обнови\s+remote)/i,
  stash: /(?:^|[^a-zа-яё])(?:стэш|стеш|stash)(?![a-zа-яё])/i,
  rebase: /(?:ребейз|ребейс|rebase)\s+(?:на|onto|on)\s+([\w./-]+)/i,
  merge: /(?:смерж|слей|merge)\s+([\w./-]+)/i,
  collapse: /(?:сверни|collapse)\s+(?:все\s+)?(?:мержи|merges)/i,
  expand: /(?:разверни|expand)\s+(?:все\s+)?(?:мержи|merges)/i,
  changes: /(?:покажи|открой|show|open)\s+(?:изменения|changes)/i,
  commits: /(?:покажи|открой|show|open)\s+(?:коммиты|историю|commits|history|graph)/i,
  // app
  hideAuthor: /(?:скрой|спрячь|убери|hide|remove)\s+(?:колонку\s+)?(?:автора|author)/i,
  showAuthor: /(?:покажи|верни|show)\s+(?:колонку\s+)?(?:автора|author)/i,
  compact: /(?:компактн|compact|плотн|dense)/i,
  roomy: /(?:обычн|normal|просторн|вернуть\s+подписи|labels back|с подписями)/i,
  scheme: /(?:схем[ау]|тем[ау]|scheme|theme)\s*(?:на\s+|to\s+)?(amber|phosphor|ice|solar|paper)/i,
  scale: /(?:масштаб|zoom|scale)\s*(?:на\s+|to\s+)?(\d{2,3})\s*%?/i,
  removeBtn: /(?:убери|удали|скрой|remove|hide)\s+(?:кнопку\s+|button\s+)?(fetch|pull|push|stash|branch|merge|rebase|more)/i,
  addBtn: /(?:добавь|add)\s+(?:кнопку\s+|button\s+)?(terminal|терминал|finder|editor|редактор|blame|history|истори[юя])/i,
  absDates: /(?:абсолютн|полные\s+даты|absolute\s+dates|full\s+dates)/i,
  relDates: /(?:относительн|relative\s+dates)/i,
  graphThick: /(?:граф\s+(?:толще|жирнее)|thicker\s+graph|graph\s+thicker)/i,
  graphThin: /(?:граф\s+(?:тоньше)|thinner\s+graph|graph\s+thinner)/i,
  sidebar: /(?:сайдбар|sidebar)\s+(шире|уже|wider|narrower)/i,
  rows: /(?:строки|rows)\s+(?:выше|ниже|taller|shorter|больше|меньше)/i,
  noStatus: /(?:убери|скрой|hide|remove)\s+(?:штамп|режим|mode\s+stamp|status\s+mode)/i,
};

export function plan(text: string, target: AgentTarget): Plan {
  const s = text.trim();
  const wantsRepo = target === 'repo';
  const wantsApp = target === 'app';
  let m: RegExpMatchArray | null;

  // ---------- app changes ----------
  if (!wantsRepo) {
    if (RX.hideAuthor.test(s)) return app('Hide the author column in the commit list', { hideAuthor: true }, ['src/components/CommitList.tsx'], '-        <View style={[colStyles.author, …]}>\n+        {!mods.hideAuthor && <View style={[colStyles.author, …]}>', 'Убрал колонку Author из списка коммитов. Автор остаётся в деталях коммита.');
    if (RX.showAuthor.test(s)) return app('Show the author column again', { hideAuthor: false }, ['src/components/CommitList.tsx'], '-        {!mods.hideAuthor && <View …>\n+        <View style={[colStyles.author, …]}>', 'Вернул колонку Author.');
    if ((m = s.match(RX.scheme))) return app(`Switch colour scheme to ${cap(m[1])}`, { scheme: m[1].toLowerCase() }, ['src/state/store.ts'], `-  theme: 'amber',\n+  theme: '${m[1].toLowerCase()}',`, `Переключил схему на ${cap(m[1])} и сделал её схемой по умолчанию.`);
    if ((m = s.match(RX.removeBtn))) return app(`Remove the ${cap(m[1])} button from the toolbar`, { hiddenToolbarButtons: [m[1].toLowerCase()] }, ['src/components/Toolbar.tsx'], `-      <ToolButton icon="${m[1].toLowerCase()}" label="${cap(m[1])}" … />`, `Убрал кнопку ${cap(m[1])} из тулбара. Команда по-прежнему доступна в палитре (⌘K).`);
    if ((m = s.match(RX.addBtn))) {
      const key = /терм|terminal/i.test(m[1]) ? 'terminal' : /finder/i.test(m[1]) ? 'finder' : /edit|редак/i.test(m[1]) ? 'editor' : /blame/i.test(m[1]) ? 'blame' : 'history';
      return app(`Add a ${cap(key)} button to the toolbar`, { extraToolbarButtons: [key] }, ['src/components/Toolbar.tsx', 'src/ui/Icon.tsx'], `+      <ToolButton icon="${key}" label="${cap(key)}" onPress={() => open${cap(key)}()} />`, `Добавил кнопку ${cap(key)} в тулбар после Rebase.`);
    }
    if (RX.absDates.test(s)) return app('Show absolute dates in the commit list', { absoluteDates: true }, ['src/components/CommitList.tsx', 'src/state/store.ts'], '-            {relTime(commit.date)}\n+            {mods.absoluteDates ? shortDate(commit.date) : relTime(commit.date)}', 'Даты в списке теперь абсолютные (дд.мм чч:мм).');
    if (RX.relDates.test(s)) return app('Show relative dates in the commit list', { absoluteDates: false }, ['src/components/CommitList.tsx'], '-            {shortDate(commit.date)}\n+            {relTime(commit.date)}', 'Вернул относительные даты.');
    if (RX.graphThick.test(s)) return app('Thicker graph lines', { graphWidth: 2.5 }, ['src/components/CommitList.tsx'], '-    const GW = 1.5;\n+    const GW = 2.5;', 'Линии графа 2.5 px.');
    if (RX.graphThin.test(s)) return app('Thinner graph lines', { graphWidth: 1 }, ['src/components/CommitList.tsx'], '-    const GW = 1.5;\n+    const GW = 1;', 'Линии графа 1 px.');
    if ((m = s.match(RX.sidebar))) {
      const wider = /шире|wider/i.test(m[1]);
      return app(wider ? 'Wider sidebar' : 'Narrower sidebar', { sidebarWidth: wider ? 300 : 180 }, ['src/state/store.ts'], `-  layout: { sidebar: 230, …\n+  layout: { sidebar: ${wider ? 300 : 180}, …`, wider ? 'Сайдбар 300 px.' : 'Сайдбар 180 px.');
    }
    if ((m = s.match(RX.rows))) {
      const taller = /выше|taller|больше/i.test(s);
      return app(taller ? 'Taller list rows' : 'Shorter list rows', { rowHeight: taller ? 26 : 20 }, ['src/theme/index.ts'], `-export const ROW = 22;\n+export const ROW = ${taller ? 26 : 20};`, taller ? 'Строки списков 26 px.' : 'Строки списков 20 px.');
    }
    if (RX.noStatus.test(s)) return app('Remove the mode stamp from the status bar', { statusMode: false }, ['src/components/StatusBar.tsx'], '-        <View style={{ backgroundColor: op ? t.info : t.accent, … }}>\n-          <Txt label …>{mode}</Txt>\n-        </View>', 'Убрал штамп режима из статус-бара.');
    if (RX.compact.test(s) && !wantsRepo) return app('Compact toolbar: icons only', { compactToolbar: true }, ['src/ui/primitives.tsx', 'src/components/Toolbar.tsx'], '-            <Txt label size={10.5} …>{label}</Txt>\n+            {!compact && <Txt label size={10.5} …>{label}</Txt>}', 'Тулбар теперь только с иконками, подписи в тултипах.');
    if (RX.roomy.test(s) && !wantsRepo) return app('Toolbar with labels', { compactToolbar: false }, ['src/components/Toolbar.tsx'], '-            {!compact && <Txt …>{label}</Txt>}\n+            <Txt label size={10.5} …>{label}</Txt>', 'Вернул подписи в тулбар.');
    if ((m = s.match(RX.scale))) return { kind: 'repo', actions: [{ label: `Interface scale ${m[1]}%`, run: 'scale', arg: m[1] }], reply: `Масштаб интерфейса ${m[1]}%. Это настройка, не изменение исходников, в журнал версий не попадает.` };
  }

  // ---------- repository ----------
  if (!wantsApp) {
    if ((m = s.match(RX.branch))) return repo([{ label: `git switch -c ${m[1]}`, run: 'createBranch', arg: m[1] }], `Создал ветку ${m[1]} от HEAD и переключился на неё.`);
    if ((m = s.match(RX.rebase))) return repo([{ label: `git rebase ${m[1]}`, run: 'rebase', arg: m[1] }], `Запускаю rebase текущей ветки на ${m[1]}. Прогресс в статус-баре.`);
    if ((m = s.match(RX.merge))) return repo([{ label: `git merge ${m[1]}`, run: 'merge', arg: m[1] }], `Сливаю ${m[1]} в текущую ветку.`);
    if (RX.collapse.test(s)) return repo([{ label: 'collapse all merges', run: 'collapseAll' }], 'Свернул все мержи в графе.');
    if (RX.expand.test(s)) return repo([{ label: 'expand all merges', run: 'expandAll' }], 'Развернул мержи.');
    if (RX.changes.test(s)) return repo([{ label: 'open Changes', run: 'section', arg: 'changes' }], 'Открыл локальные изменения.');
    if (RX.commits.test(s)) return repo([{ label: 'open All Commits', run: 'section', arg: 'commits' }], 'Открыл историю.');
    if (RX.push.test(s)) return repo([{ label: 'git push', run: 'push' }], 'Пушу текущую ветку в origin.');
    if (RX.pull.test(s)) return repo([{ label: 'git pull --rebase', run: 'pull' }], 'Подтягиваю изменения с rebase.');
    if (RX.fetch.test(s)) return repo([{ label: 'git fetch --prune', run: 'fetch' }], 'Делаю fetch всех remote.');
    if (RX.stash.test(s)) return repo([{ label: 'git stash push -u', run: 'stash' }], 'Спрятал рабочие изменения в stash.');
    if ((m = s.match(RX.checkout)) && !/ветку|branch/i.test(s.slice(0, m.index ?? 0))) return repo([{ label: `git switch ${m[1]}`, run: 'checkout', arg: m[1] }], `Переключаюсь на ${m[1]}.`);
    if ((m = s.match(RX.commit))) {
      const msg = (m[1] ?? '').trim();
      return repo([{ label: 'git add -A', run: 'stageAll' }, { label: `git commit -m "${msg || 'Update'}"`, run: 'commit', arg: msg || 'Update' }], msg ? `Добавил все изменения и закоммитил: «${msg}».` : 'Добавил все изменения и закоммитил с сообщением «Update». Лучше дать сообщение: «закоммить: исправил граф».');
    }
  }

  return {
    kind: 'help',
    reply:
      'В реальном приложении этот запрос ушёл бы в Claude Code с доступом к репозиторию и к исходникам Prong. В прототипе понимаю такие команды:\n' +
      '• репозиторий: «создай ветку X», «переключись на X», «закоммить: сообщение», «запушь», «pull», «fetch», «стэш», «ребейз на origin/main», «смерж X», «сверни мержи», «покажи изменения»\n' +
      '• интерфейс: «скрой колонку автора», «компактный тулбар», «убери кнопку Merge», «добавь кнопку Terminal», «схема на Ice», «абсолютные даты», «граф толще», «сайдбар шире», «строки выше», «убери штамп режима», «масштаб 125%»',
  };
}

function app(title: string, patch: Partial<AppMods>, files: string[], diff: string, reply: string): AppPlan {
  return { kind: 'app', title, patch, files, diff, reply };
}
function repo(actions: RepoPlan['actions'], reply: string): RepoPlan {
  return { kind: 'repo', actions, reply };
}
function cap(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

export const SUGGESTIONS: { text: string; target: 'repo' | 'app' }[] = [
  { text: 'создай ветку feature/agent-panel', target: 'repo' },
  { text: 'закоммить: wire agent panel', target: 'repo' },
  { text: 'ребейз на origin/main', target: 'repo' },
  { text: 'скрой колонку автора', target: 'app' },
  { text: 'компактный тулбар', target: 'app' },
  { text: 'добавь кнопку Terminal', target: 'app' },
  { text: 'схема на Ice', target: 'app' },
  { text: 'абсолютные даты', target: 'app' },
];
