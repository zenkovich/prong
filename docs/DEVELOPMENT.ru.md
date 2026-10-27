# Prong — заметки для разработки

Прежний README (до 2026-10-28), дополненный командами тестов. Краткое описание проекта на английском — в [README.md](../README.md).

Кроссплатформенный git-клиент в духе Fork на React Native. git-движок — локальный сервис (`server/`), приложение работает и с настоящими репозиториями, и на мок-данных.

- Функциональный дизайн: [DESIGN.md](DESIGN.md)
- Десять направлений визуального стиля: [DESIGN-STYLES.md](DESIGN-STYLES.md), интерактивные макеты — [design-styles.html](design-styles.html) (открывается локально в браузере)
- Производительность на большом репозитории: [PERFORMANCE.md](PERFORMANCE.md)
- Стек: Expo SDK 58 / React Native 0.88 / TypeScript, `react-native-web` для браузера, `react-native-svg` для графа и иконок. Внешних UI-библиотек нет.

## Запуск

```bash
npm install && (cd server && npm install)
npm run server     # git-движок на http://127.0.0.1:8790 (нужен установленный git)
npm run web        # http://localhost:8081 — приложение в браузере
```

Демо-репозиториев нет: список заполняется из `~/.prong/repos.json` (Open / Clone / сканирование папки воркспейса). Без запущенного движка Open и Clone сообщают «engine offline».

## Тесты

```bash
npm test                 # юнит-тесты приложения: стор, live-слой, граф, агент, вкладки, медиа, иконки
npm run server:test      # движок: парсеры, настоящий git, медиа и Range, Origin, иконки ОС, HTTP-API
npm run e2e              # все наборы сквозных проверок в headless Chromium (после macos/build.sh), ~15 мин
npm run test:all         # typecheck + lint + всё перечисленное
npm run test:affected    # только то, что задела правка: vitest related + наборы e2e её области
```

Тест-кейсы по блокам: [TEST-PLAN.md](TEST-PLAN.md). Агент в e2e — заглушка `tools/fake-claude.sh`, без сети и денег.

Сквозные проверки разбиты на наборы: главный `tools/e2e.mjs` (его проверки опираются друг на друга, идёт только целиком) и независимые `tools/e2e/suites/{smoke,changes,history,sidebar,toolbar,shell,agent}.mjs`. У каждого свой движок на случайном порту, временная папка состояния и свои репозитории-фикстуры; `~/.prong` и ваши репозитории не трогаются.

```bash
node tools/e2e/suites/changes.mjs                  # один набор
E2E_ONLY='hover' node tools/e2e/suites/changes.mjs # только проверки, чьё имя совпало
E2E_JOBS=2 node tools/e2e/run-all.mjs '^(changes|history)$'
npm run test:affected -- --suites changes --only 'submodule'   # общий код: сценарий выбирается явно
npm run test:affected -- --dry                     # что запустится
```

Профайлер на большом репозитории (только чтение): `node tools/profile.mjs <repo> --web <web-export>`, подробности в [PERFORMANCE.md](PERFORMANCE.md).

## macOS-приложение

```bash
macos/fetch-node.sh        # один раз: портативный Node 22 LTS в macos/vendor (не в git)
macos/build.sh --run       # собирает macos/build/Prong.app и запускает
```

`Prong.app` = Swift-оболочка (AppKit + WKWebView, `macos/Sources/main.swift`) + веб-сборка + движок (`server/dist` + node) в `Contents/Resources`. Оболочка запускает движок дочерним процессом на свободном порту (8790+), ждёт `/api/health` и открывает интерфейс, который движок же и раздаёт. Нативные сервисы через мост `window.webkit.messageHandlers.prong`: выбор папки в Open/Clone, Reveal in Finder, Open in Terminal (`src/desktop.ts`). Лог движка: `~/.prong/engine.log`, меню View → Engine Log. Подпись ad hoc, для раздачи нужны Developer ID и нотаризация.

Почему не react-native-macos: его актуальная версия 0.81 отстаёт от RN 0.88 (Expo 58), на котором собран проект; оболочка с WKWebView даёт standalone-приложение сейчас, переход на нативные RN-виджеты остаётся в плане.

## Что кликается

- Welcome: список репозиториев, Open / Clone (GitHub-список или URL, с прогрессом) / Init.
- Репозиторий: вкладки, тулбар (Fetch / Pull / Push / Stash / Branch / Merge / Rebase / More), сайдбар (Changes, All Commits, Branches-дерево, Remotes, Tags, Stashes), статус-бар с прогрессом операций.
- All Commits: граф одним SVG-слоем (без разрывов), сворачивание мержей (клик по узлу, ←/→, «+N hidden»), фильтр веток (All / Current / Selected, скрыть remote; из сайдбара «Show only this branch»), поиск, контекстное меню коммита (checkout, branch, tag, cherry-pick, revert, reset, rebase, interactive rebase, copy).
- Changes: unstaged/staged, stage/unstage файла и отдельного хунка, discard, конфликт (ours/base/theirs), commit (+amend, commit & push).
- Дифф: unified / split, подсветка синтаксиса, картинки before/after, бинарники, сабмодули, rename, большие файлы.
- Диалоги: clone, open, init, preferences (general / GitHub Device Flow и PAT / SSH-ключи: генерация, agent, upload в GitHub, test), rebase (в т.ч. интерактивный с pick/reword/edit/squash/fixup/drop и переупорядочиванием), push, pull, fetch, branch, merge, tag, reset, stash, command palette (⌘K), shortcuts (⌘/).
- ИИ-агент (кнопка agent сверху справа, ⌘J): текстовые команды по репозиторию и по изменению самого интерфейса; журнал версий с Revert / Roll back / Reset to factory; настройки провайдера (по умолчанию Anthropic через локальный Claude Code). Без движка (статическая web-сборка) агент — мок с набором команд (`src/agent/mockAgent.ts`).
- Папка воркспейса с автосканированием репозиториев (Edit workspace → Root folder, Rescan), сабмодули в сайдбаре (update / sync / open), настоящие действия вместо заглушек (история файла, blame, remotes, upstream, теги, редактор/терминал/Finder, SSH, GitHub по токену, агент через Claude Code).
- Воркспейсы (@work / @home: свои репозитории и вкладки, перенос репозиториев), пять цветовых схем (Amber, Phosphor, Ice, Solar, Paper), масштаб интерфейса 80–150 % (⌘+ / ⌘− / ⌘0).
- Визуальная система «01 Monospace Terminal» (JetBrains Mono, радиус 0, инверсное выделение, чипы в [скобках], ромбы в графе), всплывающие элементы на матовом стекле; тёмная и светлая тема.

## Структура

```
App.tsx                     провайдер темы, хоткеи, оверлеи
src/theme                   токены тем
src/git/types.ts            доменные типы (Commit, Ref, FileChange, Hunk …)
src/git/mock/fixtures.ts    мок-история, диффы, аккаунты, ключи
src/state/store.ts          стор (useSyncExternalStore) + все мок-операции git
src/ui                      примитивы (кнопки, строки, инпуты, сплиттер, анимации), иконки, модалки/меню/тосты
src/components              Toolbar, Sidebar, CommitList + graphLayout, CommitDetails, ChangesPanel, DiffView, FileList, StatusBar, dialogs
src/screens                 Welcome, Repository
server/                     git-движок: src/git/{run,parse,repo}.ts, src/api.ts, test/
src/git/GitClient.ts        интерфейс движка + HttpGitClient
src/state/live.ts           действия стора для живых репозиториев (вызов сервиса + refresh)
tools/screenshots*.js       Playwright-прогоны по экранам и по живому репозиторию
```

## Скриншоты экранов

`tools/screenshots.js` открывает dev-сервер, проходит по экранам и складывает PNG рядом. Нужен playwright и путь к Chromium:

```bash
npm run web -- --port 8099 &
cd tools && npm i playwright && CHROME=~/Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-mac-arm64/chrome-headless-shell node screenshots.js
```

## Сторонние ресурсы

Иконки файлов и папок — [Material Icon Theme](https://github.com/material-extensions/vscode-material-icon-theme) (MIT, лицензия в `public/file-icons/LICENSE.txt`). Набор собирается `npm run icons` (`tools/gen-file-icons.mjs`): SVG кладутся в `public/file-icons/`, таблица соответствий в `src/ui/fileIconMap.generated.ts`. Для неизвестных расширений иконку отдаёт ОС через движок (`/api/fileicon`).
