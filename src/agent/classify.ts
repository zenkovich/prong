/**
 * Routes an AUTO-mode agent request to the repository or to the app's own sources.
 * The mock planner only recognises its scripted commands; everything else used to fall back to the
 * repository, so "сделай теги в левой панели свёрнутыми" ran as a git task. This looks at the
 * vocabulary instead: UI nouns win over git verbs when both appear, because a request about how the
 * client shows tags is about the client.
 */

// note: JS \b is ASCII-only, so Cyrillic words use explicit (?![а-яё]) boundaries
const UI = /(панел|интерфейс|сайдбар|sidebar|тулбар|toolbar|кнопк|button|тем[аыу](?![а-яё])|схем[аыу]|цвет|colou?r|шрифт|font|иконк|icon|окн[оа]|диалог|dialog|попап|popup|меню|menu|статус-?бар|status ?bar|масштаб|scale|граф[ае]?(?![а-яё])|graph|колонк|column|строк[иа]\s+(списк|коммит)|row height|свернут|сворач|collapsed?|раскрыт|развёрнут|по умолчанию|default|настройк|settings|preferences|prong|приложени|the app|ui\b|layout|анимац|animation|отступ|padding|margin|hotkey|хоткей|горяч\w+ клавиш|шорткат|shortcut|команд\w+ палитр|палитр)/i;
const GIT = /((?<![а-яё])ветк|branch|коммит|commit|rebase|ребейз|merge|мерж|слить|слей|push|запуш|pull|fetch|stash|стэш|стеш|checkout|переключись|cherry|tag\b|тег(?![а-яё])|тэг(?![а-яё])|reset|revert|откат|submodule|сабмодул|remote|origin|upstream|clone|клонир|diff|дифф|blame|log\b|история|amend|squash|squash|stage|застейдж|index|индекс|worktree|conflict|конфликт|\.gitignore|gitignore)/i;

export type AgentTargetGuess = 'repo' | 'app';

export function classifyAgentTarget(text: string): AgentTargetGuess {
  const s = text.trim();
  const ui = UI.test(s);
  const git = GIT.test(s);
  if (ui && !git) return 'app';
  if (git && !ui) return 'repo';
  if (ui && git) {
    // both vocabularies: the request is about the UI when it describes how something is shown,
    // and about the repository when it asks for a git action on named refs
    const action = /^(создай|сделай ветку|переключи|закоммит|запуш|push|pull|fetch|ребейз|rebase|merge|смерж|слей|стэш|stash|удали ветк|откати|revert|reset|cherry|clone|клонир)/i.test(s);
    const shown = /(панел|интерфейс|сайдбар|sidebar|тулбар|toolbar|кнопк|button|свернут|сворач|collapsed?|по умолчанию|default|показыва|отобража|display|show|hide|скрой|убери колонк|колонк|column|цвет|colou?r|шрифт|font|иконк|icon|граф[ае]?(?![а-яё])|graph)/i.test(s);
    if (shown && !action) return 'app';
    return 'repo';
  }
  return 'repo';
}

/** words of either kind in the request: without them ("да, сделай", "почему?") it is a reply, not a new task */
export function mentionsTarget(text: string) {
  return UI.test(text) || GIT.test(text);
}

/** Marker the server-side system prompt asks Claude Code to answer with when a request was routed to the wrong target. */
export const RETARGET_MARKER = /^\s*PRONG_TARGET:\s*(app|repo)\s*$/m;
