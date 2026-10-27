#!/usr/bin/env python3
"""
The test report: every e2e check with the screenshot of how it ended, every unit and engine test, as one HTML page.

  E2E_REPORT=<dir> node tools/e2e/run-all.mjs              # <dir>/<suite>.json + <dir>/shots/*.jpg
  npx vitest run --reporter=json --outputFile=<dir>/unit.json
  (cd server && npx vitest run --reporter=json --outputFile=<dir>/engine.json)
  python3 tools/test-report.py <dir>                        # → <dir>/index.html (shots/ next to it)

The page follows the artifact page contract (no <html>/<head>/<body> of its own) and opens as a plain file too.
"""
import html
import json
import os
import sys
from datetime import date

D = sys.argv[1] if len(sys.argv) > 1 else '.'
esc = html.escape

# ---------- what each part tests (the names of the tests say what each one checks) ----------

SUITES = [
    ('main', 'Основной прогон', 'Сквозные сценарии по всему приложению: стартовый экран и workspaces, медиа-диффы (картинки, звук, видео), ветки и двойной щелчок, очередь действий и lock-файлы, отмена, сабмодули, подключения, клон, агент и сборка интерфейса.'),
    ('changes', 'Changes', 'Списки Unstaged и Staged: каждый вид строки и её счётчики, дерево и папки (в том числе новые), выделение, кнопки при наведении, меню, ханки и строки, файлы без перевода строки, большой дифф, коммит и Amend, конфликты слияния, изменения снаружи.'),
    ('history', 'История', 'Граф коммитов: загрузка, строки и метки, поиск по всей истории, фильтр веток, клавиатура, детали коммита, его файлы и диффы, Expand context, меню коммита и его диалоги (ветка, тег, cherry-pick, revert, reset, rebase), история файла, blame, стэши.'),
    ('sidebar', 'Сайдбар', 'Ветки, папки веток и их свёртки, remotes, теги, сабмодули, стэши, версии homescapes, двойной щелчок, меню каждой строки и диалоги (переименование, upstream, удаление, remote), мультивыделение, фильтр, ширина.'),
    ('toolbar', 'Тулбар и статус', 'Fetch, Pull, Push и их меню и диалоги с опциями, Stash, Branch, Merge, Rebase, More, палитра команд; панель статуса: прогресс, Stop, ожидание lock-файла, ошибки и их подсказки; диалог подключения; горячие клавиши.'),
    ('shell', 'Оболочка', 'Стартовый экран и workspaces, вкладки и список ⌘T, открытие репозитория (в том числе без коммитов и удалённого), Clone, аккаунты GitHub, SSH-ключи, настройки, раскладка и разделители, восстановление после краха.'),
    ('agent', 'Агент', 'Командная строка агента и его карточки, панель чата, Markdown в ответах, режимы (репозиторий, интерфейс), настройки, версии интерфейса (откат, повтор, Roll back), Ask AI из окна ошибки, проверки подключения и экрана краха.'),
    ('smoke', 'Стенд', 'Проверка самого стенда: набор получает свой движок, свой репозиторий и стартовый экран.'),
]

UNIT = {
    'src/agent/classify.test.ts': 'К чему относится просьба агенту: к репозиторию или к интерфейсу.',
    'src/agent/mockAgent.test.ts': 'Демо-агент без Claude Code: какие команды он предлагает.',
    'src/agent/status.test.ts': 'Строка статуса агента и сводка карточки по событиям Claude Code.',
    'src/git/gitignore.test.ts': 'Строка .gitignore для файла: якорь и экранирование (сверено с git).',
    'src/git/lineStaging.test.ts': 'Патч для выбранных строк ханка: пары строк, конец файла без перевода строки.',
    'src/git/remoteUrl.test.ts': 'Разбор адреса remote.',
    'src/state/deepHistory.test.ts': 'Переход к коммиту, которого ещё нет среди загруженных: чтение истории вглубь.',
    'src/state/errorHints.test.ts': 'Подсказки к ошибкам git: publickey, lock, отказ push, host key и другие.',
    'src/state/fileSelection.test.ts': 'Выделение файлов и папок в Changes: ⌘, Shift, другая секция.',
    'src/state/history.test.ts': 'История: загрузка, поиск, листание, раскрытие коммита.',
    'src/state/live.test.ts': 'Слой связи с движком: скан workspaces, события агента, настройки.',
    'src/state/longOps.test.ts': 'Долгие операции: какая вкладка обновляется, что останавливает Stop, лог, потеря движка.',
    'src/state/session.test.ts': 'Сессия между запусками: вкладки, фильтры, свёртки, отсутствующие репозитории.',
    'src/state/store.test.ts': 'Состояние приложения: вкладки, workspaces, pin, тема, Amend, разделители.',
    'src/components/branchFilter.test.ts': 'Фильтр графа по веткам.',
    'src/components/branchNames.test.ts': 'Имена веток: правила git, парная удалённая ветка.',
    'src/components/commitRefs.test.ts': 'Метки веток и тегов в строке коммита.',
    'src/components/fileTree.test.ts': 'Дерево файлов: папки, неотслеживаемые папки, ключи строк.',
    'src/components/graphLayout.test.ts': 'Раскладка графа коммитов по дорожкам.',
    'src/components/highlight.test.ts': 'Подсветка синтаксиса в диффе.',
    'src/components/markdownSyntax.test.ts': 'Разбор Markdown в ответах агента.',
    'src/components/pathTree.test.ts': 'Дерево путей (сабмодули, ветки).',
    'src/components/refSelection.test.ts': 'Выделение веток с ⌘ и Shift.',
    'src/components/tabLayout.test.ts': 'Ширина вкладок и их группы.',
    'src/components/versions.test.ts': 'Версии homescapes (ver/NNN) в сайдбаре.',
    'src/ui/ErrorBoundary.test.ts': 'Перехват крахов и восстановление панели.',
    'src/ui/droppedPath.test.ts': 'Путь из того, что перетащили в окно.',
    'src/ui/fileIconResolve.test.ts': 'Иконка файла по имени и расширению.',
    'src/components/media/mediaMath.test.ts': 'Масштаб и сравнение картинок в диффе.',
}
ENGINE = {
    'server/test/api.test.ts': 'API движка: репозитории, workspaces, аккаунты, клон с подключением, скан.',
    'server/test/appsources.test.ts': 'Версии интерфейса, которые делает агент: запись, откат, повтор, дифф.',
    'server/test/auth.test.ts': 'Подключение репозитория: SSH-ключ, аккаунт, хост и владелец.',
    'server/test/avatars.test.ts': 'Аватары авторов.',
    'server/test/batch.test.ts': 'Удаление и push нескольких веток сразу.',
    'server/test/changes.test.ts': 'Рабочая копия на настоящем git: строки без перевода, переименования, режим файла, конфликты, кириллица.',
    'server/test/fileicons.test.ts': 'Системные иконки файлов macOS.',
    'server/test/folder-paths.test.ts': 'Тысячи путей за раз, новые папки и их файлы, счёт строк, уборка пустых папок.',
    'server/test/history.test.ts': 'История на настоящем git: поиск, история файла через переименования, контекст диффа.',
    'server/test/large.test.ts': 'Большие репозитории и большие диффы.',
    'server/test/media.test.ts': 'Стороны медиа-файлов для превью.',
    'server/test/origin.test.ts': 'Защита API: откуда можно звать движок.',
    'server/test/parse.test.ts': 'Разбор вывода git: log, status, diff, numstat.',
    'server/test/queue.test.ts': 'Очередь действий репозитория и ожидание lock-файлов.',
    'server/test/repo-ops.test.ts': 'Операции с ветками, remotes и тегами на настоящем git.',
    'server/test/repo.test.ts': 'Основа: снимок репозитория, stage, коммит, дифф.',
    'server/test/secrets-ssh.test.ts': 'Секреты в тестовом режиме и SSH-ключи только в своей папке.',
    'server/test/services.test.ts': 'Внешние инструменты: редактор, Finder, терминал.',
    'server/test/stop.test.ts': 'Stop действительно останавливает git.',
    'server/test/submodule-range.test.ts': 'Коммиты сабмодуля между двумя указателями.',
    'server/test/sync-options.test.ts': 'Опции Fetch, Pull, Push.',
    'server/test/tokens.test.ts': 'Токены GitHub: хранение, обновление, истечение.',
    'server/test/undo.test.ts': 'Копии для отмены Discard и имена веток на нечувствительном к регистру диске.',
}


def load(name):
    p = os.path.join(D, name)
    return json.load(open(p)) if os.path.exists(p) else None


def fmt_ms(ms):
    return f'{ms / 1000:.1f} с' if ms >= 1000 else f'{ms} мс'


suites = []
for key, title, about in SUITES:
    j = load(f'{key}.json')
    if j:
        suites.append((key, title, about, j['checks']))


def vitest_files(j, known):
    out = []
    for f in j['testResults']:
        rel = f['name'].split('/prong/')[-1]
        tests = [(' › '.join(t.get('ancestorTitles', []) + [t['title']]), t['status'] == 'passed', t.get('duration') or 0) for t in f['assertionResults']]
        out.append((rel, known.get(rel, ''), tests))
    return sorted(out, key=lambda x: x[0])


unit = load('unit.json')
engine = load('engine.json')
unit_files = vitest_files(unit, UNIT) if unit else []
engine_files = vitest_files(engine, ENGINE) if engine else []

n_e2e = sum(len(c) for *_, c in suites)
ok_e2e = sum(1 for *_, c in suites for x in c if x['ok'])
n_unit = sum(len(t) for *_, t in unit_files)
ok_unit = sum(1 for *_, t in unit_files for x in t if x[1])
n_eng = sum(len(t) for *_, t in engine_files)
ok_eng = sum(1 for *_, t in engine_files for x in t if x[1])
total, passed = n_e2e + n_unit + n_eng, ok_e2e + ok_unit + ok_eng

# ---------- the page ----------

css = """
/* layout: a terminal-like report — the index on the left, one column of checks; each e2e check is a row with the
   screenshot of how it ended. Prong's own system: one monospace face, no radii, one amber accent. */
:root {
  --bg: #f3f3f0; --panel: #fafaf7; --raised: #e6e6e1; --border: #d9d9d3; --border-strong: #bdbdb6;
  --text: #1d2126; --muted: #5f6872; --faint: #8a939b;
  --accent: #a86f08; --accent-text: #fffaf0; --accent-soft: rgba(168,111,8,0.12);
  --ok: #1f8a4c; --fail: #c9372c; --info: #0e7c8a;
  --mono: 'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  --body: 'IBM Plex Sans', -apple-system, 'Segoe UI', system-ui, sans-serif;
  --shot-shadow: 0 1px 0 rgba(0,0,0,0.04);
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --bg: #0f1113; --panel: #131619; --raised: #1f2429; --border: #262c33; --border-strong: #343c45;
  --text: #d9dee3; --muted: #8a949e; --faint: #66717c;
  --accent: #e8b23b; --accent-text: #15120a; --accent-soft: rgba(232,178,59,0.14);
  --ok: #6ad48c; --fail: #ff7369; --info: #5fcad8; --shot-shadow: 0 0 0 1px rgba(255,255,255,0.03); color-scheme: dark } }
:root[data-theme="dark"] {
  --bg: #0f1113; --panel: #131619; --raised: #1f2429; --border: #262c33; --border-strong: #343c45;
  --text: #d9dee3; --muted: #8a949e; --faint: #66717c;
  --accent: #e8b23b; --accent-text: #15120a; --accent-soft: rgba(232,178,59,0.14);
  --ok: #6ad48c; --fail: #ff7369; --info: #5fcad8; --shot-shadow: 0 0 0 1px rgba(255,255,255,0.03); color-scheme: dark }
* { box-sizing: border-box; }
[hidden] { display: none !important; }
body { background: var(--bg); color: var(--text); font-family: var(--body); font-size: 14px; line-height: 1.5; margin: 0; }
.wrap { max-width: 1240px; margin: 0 auto; padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); padding-block: 28px 64px; }
header.top { display: grid; gap: 18px; border-bottom: 1px solid var(--border); padding-bottom: 22px; }
.eyebrow { font-family: var(--mono); font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--muted); }
.eyebrow b { color: var(--accent); font-weight: 600; }
h1 { font-family: var(--mono); font-weight: 600; font-size: clamp(24px, 3.4vw, 34px); line-height: 1.15; margin: 0; text-wrap: balance; letter-spacing: -0.01em; }
h1 .cursor { display: inline-block; width: 0.55em; height: 1em; background: var(--accent); vertical-align: -0.12em; margin-left: 0.12em; }
.lede { max-width: 68ch; color: var(--muted); margin: 0; }
.lede code, .run code { font-family: var(--mono); font-size: 12.5px; color: var(--text); background: var(--raised); padding: 1px 5px; }
.tally { display: flex; flex-wrap: wrap; gap: 0; border: 1px solid var(--border); background: var(--panel); }
.tally > div { padding: 12px 18px; border-right: 1px solid var(--border); min-width: 0; flex: 1 1 140px; }
.tally > div:last-child { border-right: 0; }
.tally .n { font-family: var(--mono); font-size: 22px; font-weight: 600; font-variant-numeric: tabular-nums; }
.tally .n .of { color: var(--faint); font-weight: 400; font-size: 15px; }
.tally .l { font-family: var(--mono); font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }
.tally .all .n { color: var(--ok); }
.tally .all.bad .n { color: var(--fail); }
.layout { display: grid; grid-template-columns: 220px minmax(0, 1fr); gap: 36px; margin-top: 26px; align-items: start; }
nav.index { position: sticky; top: calc(env(safe-area-inset-top, 0px) + 16px); font-family: var(--mono); font-size: 12.5px; display: grid; gap: 14px; max-height: calc(100vh - 32px); overflow: auto; }
nav.index .grp { display: grid; gap: 2px; }
nav.index .grp > span { font-size: 10.5px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--faint); padding: 0 8px 4px; }
nav.index a { display: flex; justify-content: space-between; gap: 8px; padding: 3px 8px; color: var(--text); text-decoration: none; }
nav.index a:hover { background: var(--raised); }
nav.index a:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
nav.index a .c { color: var(--faint); font-variant-numeric: tabular-nums; }
.search { display: flex; align-items: center; gap: 8px; border: 1px solid var(--border-strong); background: var(--panel); padding: 0 10px; height: 34px; }
.search:focus-within { border-color: var(--accent); }
.search span { color: var(--accent); font-family: var(--mono); font-weight: 700; }
.search input { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; color: var(--text); font-family: var(--mono); font-size: 13px; }
.found { font-family: var(--mono); font-size: 11.5px; color: var(--muted); margin-top: 6px; min-height: 1.4em; }
section.part { margin-top: 34px; scroll-margin-top: 16px; }
section.part:first-of-type { margin-top: 0; }
.part-head { display: grid; gap: 6px; border-bottom: 1px solid var(--border); padding-bottom: 10px; margin-bottom: 4px; }
.part-head h2 { font-family: var(--mono); font-size: 17px; font-weight: 600; margin: 0; display: flex; flex-wrap: wrap; align-items: baseline; gap: 10px; }
.part-head h2 .k { font-size: 11px; font-weight: 500; letter-spacing: 0.1em; text-transform: uppercase; color: var(--accent-text); background: var(--accent); padding: 1px 6px; }
.part-head h2 .cnt { font-size: 12px; font-weight: 400; color: var(--muted); font-variant-numeric: tabular-nums; }
.part-head p { margin: 0; color: var(--muted); max-width: 78ch; }
.part-head .file { font-family: var(--mono); font-size: 12px; color: var(--faint); }
ol.checks { list-style: none; margin: 0; padding: 0; }
li.check { display: grid; grid-template-columns: 252px minmax(0, 1fr); gap: 18px; padding: 14px 0; border-bottom: 1px solid var(--border); }
li.check .shot { display: block; padding: 0; border: 1px solid var(--border); background: var(--raised); cursor: zoom-in; aspect-ratio: 16 / 10; width: 100%; max-width: 100%; overflow: hidden; box-shadow: var(--shot-shadow); }
li.check .shot:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
li.check .shot img { display: block; width: 100%; height: 100%; object-fit: cover; object-position: top left; }
li.check .noshot { aspect-ratio: 16 / 10; border: 1px dashed var(--border-strong); display: grid; place-items: center; color: var(--faint); font-family: var(--mono); font-size: 11px; }
.meta { font-family: var(--mono); font-size: 11.5px; color: var(--faint); display: flex; gap: 12px; align-items: center; flex-wrap: wrap; font-variant-numeric: tabular-nums; }
.st { font-weight: 700; letter-spacing: 0.06em; }
.st.ok { color: var(--ok); }
.st.fail { color: var(--fail); }
.name { margin: 4px 0 0; font-size: 14.5px; line-height: 1.45; max-width: 75ch; }
.err { margin-top: 6px; font-family: var(--mono); font-size: 12px; color: var(--fail); white-space: pre-wrap; }
details.file { border-bottom: 1px solid var(--border); }
details.file > summary { list-style: none; cursor: pointer; padding: 10px 0; display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px 14px; align-items: baseline; }
details.file > summary::-webkit-details-marker { display: none; }
details.file > summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
details.file > summary .path { font-family: var(--mono); font-size: 13px; overflow-wrap: anywhere; }
details.file > summary .path::before { content: '▸'; color: var(--accent); margin-right: 8px; display: inline-block; transition: transform 120ms; }
details.file[open] > summary .path::before { transform: rotate(90deg); }
details.file > summary .tc { font-family: var(--mono); font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
details.file > summary .about { grid-column: 1 / -1; color: var(--muted); font-size: 13.5px; padding-left: 20px; }
ul.tests { list-style: none; margin: 0 0 12px; padding: 0 0 0 20px; display: grid; gap: 2px; }
ul.tests li { display: grid; grid-template-columns: 34px minmax(0, 1fr) auto; gap: 10px; font-size: 13.5px; padding: 2px 0; }
ul.tests li .st { font-family: var(--mono); font-size: 11px; padding-top: 2px; }
ul.tests li .ms { font-family: var(--mono); font-size: 11px; color: var(--faint); font-variant-numeric: tabular-nums; padding-top: 2px; }
.run { margin-top: 40px; border-top: 1px solid var(--border); padding-top: 16px; color: var(--muted); font-size: 13px; display: grid; gap: 6px; }
.lightbox { position: fixed; inset: 0; background: rgba(8,9,10,0.9); display: grid; grid-template-rows: auto minmax(0, 1fr); z-index: 20; padding: calc(env(safe-area-inset-top, 0px) + 12px) max(16px, env(safe-area-inset-right, 0px)) calc(env(safe-area-inset-bottom, 0px) + 16px) max(16px, env(safe-area-inset-left, 0px)); }
.lightbox .bar { display: flex; gap: 12px; align-items: flex-start; color: #e6e9ec; font-size: 13.5px; padding-bottom: 10px; }
.lightbox .bar .t { flex: 1; min-width: 0; }
.lightbox .bar .t b { font-family: var(--mono); color: #e8b23b; font-weight: 600; margin-right: 8px; }
.lightbox button { font-family: var(--mono); font-size: 12px; background: #1f2429; color: #e6e9ec; border: 1px solid #343c45; padding: 6px 10px; cursor: pointer; }
.lightbox button:hover { border-color: #e8b23b; }
.lightbox button:focus-visible { outline: 2px solid #e8b23b; outline-offset: 1px; }
.lightbox .img { min-height: 0; display: grid; place-items: center; }
.lightbox img { max-width: 100%; max-height: 100%; object-fit: contain; border: 1px solid #343c45; }
@media (max-width: 900px) {
  .layout { grid-template-columns: minmax(0, 1fr); gap: 20px; }
  nav.index { position: static; max-height: none; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); }
  nav.index .grp { grid-column: 1 / -1; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); }
  nav.index .grp > span { grid-column: 1 / -1; }
}
@media (max-width: 620px) {
  li.check { grid-template-columns: minmax(0, 1fr); gap: 10px; }
  .tally > div { border-right: 0; border-bottom: 1px solid var(--border); }
  .tally > div:last-child { border-bottom: 0; }
}
@media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
"""

parts = []
idx_e2e, idx_unit, idx_eng = [], [], []
shots = []  # (file, caption) in page order, for the lightbox

for key, title, about, checks in suites:
    ok = sum(1 for c in checks if c['ok'])
    idx_e2e.append(f'<a href="#e2e-{key}"><span>{esc(title)}</span><span class="c">{ok}/{len(checks)}</span></a>')
    rows = []
    for i, c in enumerate(checks, 1):
        if c.get('shot'):
            n = len(shots)
            shots.append((c['shot'], f'{title} · {i}', c['name']))
            pic = f'<button class="shot" type="button" data-i="{n}" aria-label="Скриншот: {esc(c["name"][:80])}"><img src="shots/{esc(c["shot"])}" alt="" loading="lazy" decoding="async" width="1440" height="900"></button>'
        else:
            pic = '<div class="noshot">нет скриншота</div>'
        st = '<span class="st ok">PASS</span>' if c['ok'] else '<span class="st fail">FAIL</span>'
        err = f'<div class="err">{esc(c.get("error") or "")}</div>' if not c['ok'] else ''
        rows.append(f'<li class="check" data-q="{esc((title + " " + c["name"]).lower())}">{pic}<div><div class="meta">{st}<span>#{i:02d}</span><span>{fmt_ms(c["ms"])}</span></div><p class="name">{esc(c["name"])}</p>{err}</div></li>')
    file = 'tools/e2e.mjs' if key == 'main' else f'tools/e2e/suites/{key}.mjs'
    parts.append(f'<section class="part" id="e2e-{key}"><div class="part-head"><h2><span class="k">e2e</span>{esc(title)}<span class="cnt">{ok}/{len(checks)}</span></h2><p>{esc(about)}</p><span class="file">{file}</span></div><ol class="checks">{"".join(rows)}</ol></section>')


ST_OK = '<span class="st ok">PASS</span>'
ST_FAIL = '<span class="st fail">FAIL</span>'


def vitest_part(kind_id, kind, files, idx, title, about):
    blocks = []
    for rel, desc, tests in files:
        ok = sum(1 for t in tests if t[1])
        lis = ''.join(f'<li data-q="{esc((rel + " " + name).lower())}">{ST_OK if good else ST_FAIL}<span>{esc(name)}</span><span class="ms">{fmt_ms(round(ms))}</span></li>' for name, good, ms in tests)
        about_html = f'<span class="about">{esc(desc)}</span>' if desc else ''
        blocks.append(f'<details class="file" data-q="{esc((rel + " " + desc).lower())}"><summary><span class="path">{esc(rel)}</span><span class="tc">{ok}/{len(tests)}</span>{about_html}</summary><ul class="tests">{lis}</ul></details>')
    n = sum(len(t) for *_, t in files)
    k = sum(1 for *_, t in files for x in t if x[1])
    idx.append(f'<a href="#{kind_id}"><span>{esc(title)}</span><span class="c">{k}/{n}</span></a>')
    return f'<section class="part" id="{kind_id}"><div class="part-head"><h2><span class="k">{kind}</span>{esc(title)}<span class="cnt">{k}/{n} · {len(files)} файлов</span></h2><p>{esc(about)}</p></div>{"".join(blocks)}</section>'


parts.append(vitest_part('unit', 'unit', unit_files, idx_unit, 'Приложение', 'Логика интерфейса без браузера (vitest): состояние, связь с движком, раскладки, разборщики. Нажмите на файл, чтобы увидеть его тесты.'))
parts.append(vitest_part('engine', 'engine', engine_files, idx_eng, 'Движок', 'Сервер с настоящим git в временных репозиториях (vitest): операции, разбор вывода, очередь, отмена, безопасность.'))

all_ok = passed == total
shots_js = json.dumps([{'src': f'shots/{f}', 'n': n, 't': t} for f, n, t in shots], ensure_ascii=False)
today = date.today().strftime('%d.%m.%Y')

page = f"""<title>Prong Test Report</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&family=IBM+Plex+Sans:wght@400;500&display=swap">
<style>{css}</style>
<div class="wrap">
  <header class="top">
    <div class="eyebrow"><b>prong</b> · отчёт о тестах · {today}</div>
    <h1>Все тесты Prong<span class="cursor" aria-hidden="true"></span></h1>
    <p class="lede">Каждый тест назван тем, что он проверяет: имя и есть объяснение. Проверки e2e гоняют настоящий интерфейс в браузере без окна против своего движка и своих временных репозиториев; у каждой — скриншот того, чем она закончилась (нажмите, чтобы увеличить, стрелки листают).</p>
    <div class="tally">
      <div class="all{'' if all_ok else ' bad'}"><div class="n">{passed}<span class="of"> / {total}</span></div><div class="l">{'всё прошло' if all_ok else 'есть падения'}</div></div>
      <div><div class="n">{ok_e2e}<span class="of"> / {n_e2e}</span></div><div class="l">e2e · {len(suites)} прогонов</div></div>
      <div><div class="n">{ok_unit}<span class="of"> / {n_unit}</span></div><div class="l">приложение · unit</div></div>
      <div><div class="n">{ok_eng}<span class="of"> / {n_eng}</span></div><div class="l">движок · unit</div></div>
    </div>
  </header>
  <div class="layout">
    <nav class="index" aria-label="Разделы">
      <div><label class="search" for="q"><span>/</span><input id="q" type="search" placeholder="найти тест" autocomplete="off"></label><div class="found" id="found" aria-live="polite"></div></div>
      <div class="grp"><span>e2e</span>{''.join(idx_e2e)}</div>
      <div class="grp"><span>unit</span>{''.join(idx_unit)}{''.join(idx_eng)}</div>
    </nav>
    <main>
      {''.join(parts)}
      <div class="run">
        <div>Запуск: <code>npm run e2e</code> (все прогоны e2e, по 3 одновременно), <code>npm test</code>, <code>npm run server:test</code>; один набор — <code>node tools/e2e/suites/&lt;набор&gt;.mjs</code>.</div>
        <div>Отчёт: <code>E2E_REPORT=&lt;папка&gt; npm run e2e</code>, vitest с <code>--reporter=json</code>, затем <code>python3 tools/test-report.py &lt;папка&gt;</code>.</div>
      </div>
    </main>
  </div>
</div>
<div class="lightbox" id="lb" hidden role="dialog" aria-modal="true" aria-label="Скриншот">
  <div class="bar"><div class="t" id="lbt"></div><button type="button" id="lbp" aria-label="Предыдущий">←</button><button type="button" id="lbn" aria-label="Следующий">→</button><button type="button" id="lbx">Закрыть · Esc</button></div>
  <div class="img"><img id="lbi" alt=""></div>
</div>
<script>
(() => {{
  const shots = {shots_js};
  const lb = document.getElementById('lb'), img = document.getElementById('lbi'), cap = document.getElementById('lbt');
  let cur = -1, back = null;
  const show = (i) => {{
    cur = (i + shots.length) % shots.length;
    const s = shots[cur];
    img.src = s.src;
    cap.innerHTML = '';
    const b = document.createElement('b'); b.textContent = s.n; cap.append(b, document.createTextNode(s.t));
  }};
  const open = (i, from) => {{ back = from; show(i); lb.hidden = false; document.getElementById('lbx').focus(); }};
  const close = () => {{ lb.hidden = true; img.removeAttribute('src'); if (back) back.focus(); }};
  document.addEventListener('click', (e) => {{
    const b = e.target.closest('.shot');
    if (b) open(+b.dataset.i, b);
  }});
  document.getElementById('lbx').onclick = close;
  document.getElementById('lbp').onclick = () => show(cur - 1);
  document.getElementById('lbn').onclick = () => show(cur + 1);
  lb.addEventListener('click', (e) => {{ if (e.target === lb || e.target.classList.contains('img')) close(); }});
  document.addEventListener('keydown', (e) => {{
    if (lb.hidden) {{
      if (e.key === '/' && document.activeElement?.id !== 'q') {{ e.preventDefault(); document.getElementById('q').focus(); }}
      return;
    }}
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowLeft') show(cur - 1);
    else if (e.key === 'ArrowRight') show(cur + 1);
  }});
  // the search: checks, files and their tests whose text has every word typed
  const q = document.getElementById('q'), found = document.getElementById('found');
  const rows = [...document.querySelectorAll('li.check, details.file')];
  q.addEventListener('input', () => {{
    const words = q.value.toLowerCase().split(/\\s+/).filter(Boolean);
    let n = 0;
    for (const r of rows) {{
      if (r.tagName === 'DETAILS') {{
        let any = false;
        for (const li of r.querySelectorAll('ul.tests li')) {{
          const hit = !words.length || words.every((w) => li.dataset.q.includes(w) || r.dataset.q.includes(w));
          li.hidden = !hit; if (hit) {{ any = true; if (words.length) n++; }}
        }}
        r.hidden = !any;
        r.open = !!words.length && any;
      }} else {{
        const hit = !words.length || words.every((w) => r.dataset.q.includes(w));
        r.hidden = !hit; if (hit && words.length) n++;
      }}
    }}
    for (const s of document.querySelectorAll('section.part')) s.hidden = !!words.length && !s.querySelector('li.check:not([hidden]), details.file:not([hidden])');
    found.textContent = words.length ? `найдено: ${{n}}` : '';
  }});
}})();
</script>
"""
open(os.path.join(D, 'index.html'), 'w').write(page)
print(f'{os.path.join(D, "index.html")}: e2e {ok_e2e}/{n_e2e}, unit {ok_unit}/{n_unit}, engine {ok_eng}/{n_eng}, {len(shots)} screenshots')
