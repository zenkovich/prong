/**
 * Line-by-line syntax highlighting for diffs and blame (pure: no React). Every text file gets something:
 * a language definition picked by file name / extension, or a generic mode that still colours strings,
 * numbers and the usual comment markers.
 *
 * Diffs show isolated lines, so there is no cross-line state: in a C-like language a line that starts like the
 * inside or the end of a block comment (a leading star) is treated as comment.
 */

export type TokenKind = 'plain' | 'kw' | 'str' | 'num' | 'cm' | 'fn' | 'type' | 'prop' | 'tag' | 'attr' | 'punct' | 'heading' | 'emph' | 'link' | 'meta';
export interface Token {
  text: string;
  kind: TokenKind;
}

type Mode = 'code' | 'markup' | 'md' | 'yaml' | 'ini' | 'css' | 'generic';
export interface LangDef {
  id: string;
  mode: Mode;
  keywords?: Set<string>;
  lineComments?: string[];
  blockComment?: [string, string];
  /** `#include`, `#if` … at line start are preprocessor lines */
  preprocessor?: boolean;
  /** `$VAR` / `${VAR}` are variables (shell, php, make) */
  dollarVars?: boolean;
  /** keywords match regardless of case (SQL) */
  caseInsensitive?: boolean;
  /** JSON-style: a string followed by ':' is a key */
  jsonKeys?: boolean;
}

const words = (s: string) => new Set(s.split(/\s+/).filter(Boolean));
const JS = words(
  'abstract any as async await boolean break case catch class const constructor continue debugger declare default delete do else enum export extends false finally for from function get if implements import in infer instanceof interface is keyof let namespace never new null number object of package private protected public readonly return satisfies set static string super switch symbol this throw true try type typeof undefined unique unknown var void while with yield',
);
const PY = words('and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return self True try while with yield match case print');
const GO = words('break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var nil true false iota string int int64 int32 uint byte rune bool error float64 any');
const RUST = words('as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while Some None Ok Err String Vec Option Result Box');
const C = words(
  'auto bool break case catch char class const constexpr continue default delete do double else enum explicit extern false float for friend goto if inline int long mutable namespace new noexcept nullptr operator override private protected public register return short signed sizeof static struct switch template this throw true try typedef typename union unsigned using virtual void volatile while final NULL nil self super id YES NO @interface @implementation @end @property @synthesize @selector @protocol',
);
const JVM = words(
  'abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while true false null val var fun object when is in out data sealed open override internal companion lateinit suspend inline reified by init it typealias def',
);
const CS = words(
  'abstract as async await base bool break byte case catch char checked class const continue decimal default delegate do double else enum event explicit extern false finally fixed float for foreach get goto if implicit in int interface internal is lock long namespace new null object operator out override params private protected public readonly record ref return sbyte sealed set short sizeof stackalloc static string struct switch this throw true try typeof uint ulong unchecked unsafe ushort using var virtual void volatile while yield',
);
const SWIFT = words(
  'actor any as associatedtype async await break case catch class continue default defer deinit do else enum extension fallthrough false fileprivate final for func guard if import in init inout internal is lazy let mutating nil nonisolated open operator override private protocol public repeat rethrows return self Self some static struct subscript super switch throw throws true try typealias var weak where while @MainActor @Published @State @objc',
);
const PHP = words('abstract and array as break callable case catch class clone const continue declare default do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile extends final finally fn for foreach function global goto if implements include include_once instanceof insteadof interface isset list match namespace new null or print private protected public readonly require require_once return static switch throw trait true false try unset use var while yield');
const RUBY = words('alias and begin break case class def defined? do else elsif end ensure false for if in module next nil not or redo rescue retry return self super then true undef unless until when while yield require attr_accessor attr_reader private protected public');
const SHELL = words('if then else elif fi case esac for while until do done in function return local export readonly declare set unset shift exit echo printf cd source alias true false test');
const SQL = words('select from where and or not insert into values update set delete create table alter drop index view join left right inner outer full on as group by order having limit offset union all distinct null is in like between exists case when then else end primary key foreign references default unique check begin commit rollback transaction with returning');
const LUA = words('and break do else elseif end false for function goto if in local nil not or repeat return then true until while self require');
const DART = words('abstract as assert async await break case catch class const continue covariant default deferred do dynamic else enum export extends extension external factory false final finally for get hide if implements import in interface is late library mixin new null on operator part required rethrow return set show static super switch sync this throw true try typedef var void while with yield');
const MAKE = words('ifeq ifneq ifdef ifndef else endif include define endef export override');
const DOCKER = words('FROM RUN CMD LABEL EXPOSE ENV ADD COPY ENTRYPOINT VOLUME USER WORKDIR ARG ONBUILD STOPSIGNAL HEALTHCHECK SHELL AS');
const CSS_AT = words('@media @import @keyframes @font-face @supports @layer @mixin @include @extend @use @forward @if @else @each @return @function');

const L = (d: LangDef) => d;
export const LANGS: Record<string, LangDef> = {
  js: L({ id: 'js', mode: 'code', keywords: JS, lineComments: ['//'], blockComment: ['/*', '*/'] }),
  json: L({ id: 'json', mode: 'code', keywords: words('true false null'), lineComments: ['//'], blockComment: ['/*', '*/'], jsonKeys: true }),
  python: L({ id: 'python', mode: 'code', keywords: PY, lineComments: ['#'] }),
  go: L({ id: 'go', mode: 'code', keywords: GO, lineComments: ['//'], blockComment: ['/*', '*/'] }),
  rust: L({ id: 'rust', mode: 'code', keywords: RUST, lineComments: ['//'], blockComment: ['/*', '*/'] }),
  c: L({ id: 'c', mode: 'code', keywords: C, lineComments: ['//'], blockComment: ['/*', '*/'], preprocessor: true }),
  jvm: L({ id: 'jvm', mode: 'code', keywords: JVM, lineComments: ['//'], blockComment: ['/*', '*/'] }),
  csharp: L({ id: 'csharp', mode: 'code', keywords: CS, lineComments: ['//'], blockComment: ['/*', '*/'], preprocessor: true }),
  swift: L({ id: 'swift', mode: 'code', keywords: SWIFT, lineComments: ['//'], blockComment: ['/*', '*/'] }),
  php: L({ id: 'php', mode: 'code', keywords: PHP, lineComments: ['//', '#'], blockComment: ['/*', '*/'], dollarVars: true }),
  ruby: L({ id: 'ruby', mode: 'code', keywords: RUBY, lineComments: ['#'] }),
  shell: L({ id: 'shell', mode: 'code', keywords: SHELL, lineComments: ['#'], dollarVars: true }),
  sql: L({ id: 'sql', mode: 'code', keywords: SQL, lineComments: ['--'], blockComment: ['/*', '*/'], caseInsensitive: true }),
  lua: L({ id: 'lua', mode: 'code', keywords: LUA, lineComments: ['--'] }),
  dart: L({ id: 'dart', mode: 'code', keywords: DART, lineComments: ['//'], blockComment: ['/*', '*/'] }),
  make: L({ id: 'make', mode: 'code', keywords: MAKE, lineComments: ['#'], dollarVars: true }),
  docker: L({ id: 'docker', mode: 'code', keywords: DOCKER, lineComments: ['#'], dollarVars: true }),
  markup: L({ id: 'markup', mode: 'markup' }),
  css: L({ id: 'css', mode: 'css', keywords: CSS_AT, lineComments: ['//'], blockComment: ['/*', '*/'] }),
  md: L({ id: 'md', mode: 'md' }),
  yaml: L({ id: 'yaml', mode: 'yaml', lineComments: ['#'] }),
  ini: L({ id: 'ini', mode: 'ini', lineComments: ['#', ';'] }),
  generic: L({ id: 'generic', mode: 'generic', lineComments: ['#', '//'] }),
};

const EXT: Record<string, string> = {};
const map = (lang: string, exts: string) => exts.split(' ').forEach((e) => (EXT[e] = lang));
map('js', 'ts tsx js jsx mjs cjs mts cts');
map('json', 'json jsonc json5 babelrc eslintrc prettierrc');
map('python', 'py pyw pyi');
map('go', 'go');
map('rust', 'rs');
map('c', 'c h cc cpp cxx hpp hh hxx m mm ino cu metal glsl hlsl shader cginc compute frag vert');
map('jvm', 'java kt kts scala groovy gradle');
map('csharp', 'cs');
map('swift', 'swift');
map('php', 'php');
map('ruby', 'rb rake gemspec podspec');
map('shell', 'sh bash zsh fish command');
map('sql', 'sql');
map('lua', 'lua');
map('dart', 'dart');
map('make', 'mk mak');
map('markup', 'html htm xml svg vue xaml plist storyboard xib csproj vcxproj props targets resx manifest');
map('css', 'css scss sass less');
map('md', 'md mdx markdown');
map('yaml', 'yml yaml');
map('ini', 'ini cfg conf toml properties editorconfig gitconfig env');
const NAMES: Record<string, string> = { makefile: 'make', gnumakefile: 'make', dockerfile: 'docker', containerfile: 'docker', podfile: 'ruby', gemfile: 'ruby', rakefile: 'ruby', brewfile: 'ruby', 'cmakelists.txt': 'shell', '.bashrc': 'shell', '.zshrc': 'shell', '.profile': 'shell', '.gitmodules': 'ini', '.gitconfig': 'ini', '.env': 'ini', '.gitignore': 'generic', '.dockerignore': 'generic' };

export function langOf(path: string): LangDef {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  if (NAMES[name]) return LANGS[NAMES[name]];
  if (name.startsWith('dockerfile')) return LANGS.docker;
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1) : '';
  return LANGS[EXT[ext] ?? 'generic'];
}

// ---------- tokenizer ----------

const isIdStart = (c: string) => /[A-Za-z_$@]/.test(c);
const isId = (c: string) => /[\w$?!]/.test(c);
const NUM_RE = /^(0x[\da-f_]+|0b[01_]+|\d[\d_]*(\.\d+)?(e[+-]?\d+)?)[a-z%]*/i;

function push(out: Token[], text: string, kind: TokenKind) {
  if (!text) return;
  const last = out[out.length - 1];
  if (last && last.kind === kind) last.text += text;
  else out.push({ text, kind });
}

function readString(line: string, i: number): number {
  const q = line[i];
  let j = i + 1;
  while (j < line.length) {
    if (line[j] === '\\') j += 2;
    else if (line[j] === q) return j + 1;
    else j++;
  }
  return line.length;
}

function codeLine(line: string, d: LangDef, out: Token[]) {
  const trimmed = line.trimStart();
  if (d.blockComment && /^(\*|\*\/|\/\*)/.test(trimmed)) return push(out, line, 'cm');
  if (d.preprocessor && /^#\s*\w+/.test(trimmed)) return push(out, line, 'meta');
  let i = 0;
  while (i < line.length) {
    const rest = line.slice(i);
    const c = line[i];
    const lc = d.lineComments?.find((m) => rest.startsWith(m) && !(m === '#' && d.dollarVars && line[i - 1] === '$'));
    if (lc) return push(out, rest, 'cm');
    if (d.blockComment && rest.startsWith(d.blockComment[0])) {
      const end = rest.indexOf(d.blockComment[1], d.blockComment[0].length);
      const len = end < 0 ? rest.length : end + d.blockComment[1].length;
      push(out, rest.slice(0, len), 'cm');
      i += len;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const j = readString(line, i);
      const s = line.slice(i, j);
      // JSON keys: "name": …
      push(out, s, d.jsonKeys && /^\s*:/.test(line.slice(j)) ? 'prop' : 'str');
      i = j;
      continue;
    }
    if (d.dollarVars && c === '$') {
      const m = rest.match(/^\$(\{[^}]*\}|[\w@#?*!-]+|\()/);
      if (m) {
        push(out, m[0], 'prop');
        i += m[0].length;
        continue;
      }
    }
    if (/\d/.test(c) && !isId(line[i - 1] ?? ' ')) {
      const m = rest.match(NUM_RE);
      if (m) {
        push(out, m[0], 'num');
        i += m[0].length;
        continue;
      }
    }
    if (isIdStart(c)) {
      let j = i + 1;
      while (j < line.length && isId(line[j])) j++;
      const w = line.slice(i, j);
      const kw = d.keywords && (d.keywords.has(w) || (d.caseInsensitive && d.keywords.has(w.toLowerCase())));
      let kind: TokenKind = 'plain';
      if (kw) kind = 'kw';
      else if (c === '@') kind = 'meta';
      else if (/^\s*\(/.test(line.slice(j))) kind = 'fn';
      else if (/^[A-Z][a-z]/.test(w) || (/^[A-Z]/.test(w) && w.length > 1 && /[a-z]/.test(w))) kind = 'type';
      push(out, w, kind);
      i = j;
      continue;
    }
    if (c === '<' && d.id === 'js') {
      // JSX / TSX tags
      const m = rest.match(/^<\/?[A-Za-z][\w.]*/);
      if (m) {
        push(out, m[0], 'tag');
        i += m[0].length;
        continue;
      }
    }
    push(out, c, /[{}()[\];,.:=+\-*/%<>!&|^~?]/.test(c) ? 'punct' : 'plain');
    i++;
  }
}

function markupLine(line: string, out: Token[]) {
  let i = 0;
  while (i < line.length) {
    const rest = line.slice(i);
    if (rest.startsWith('<!--')) {
      const end = rest.indexOf('-->');
      const len = end < 0 ? rest.length : end + 3;
      push(out, rest.slice(0, len), 'cm');
      i += len;
      continue;
    }
    const tag = rest.match(/^<[/?!]?[\w:.-]+/);
    if (tag) {
      push(out, tag[0], 'tag');
      i += tag[0].length;
      // attributes until the tag closes
      while (i < line.length && line[i] !== '>') {
        const r = line.slice(i);
        const attr = r.match(/^\s+[\w:.@-]+/);
        if (attr) {
          push(out, attr[0], 'attr');
          i += attr[0].length;
          continue;
        }
        if (line[i] === '"' || line[i] === "'") {
          const j = readString(line, i);
          push(out, line.slice(i, j), 'str');
          i = j;
          continue;
        }
        push(out, line[i], 'punct');
        i++;
      }
      if (line[i] === '>') {
        push(out, '>', 'tag');
        i++;
      }
      continue;
    }
    if (rest.startsWith('/>') || rest.startsWith('>')) {
      const n = rest.startsWith('/>') ? 2 : 1;
      push(out, rest.slice(0, n), 'tag');
      i += n;
      continue;
    }
    const ent = rest.match(/^&[\w#]+;/);
    if (ent) {
      push(out, ent[0], 'num');
      i += ent[0].length;
      continue;
    }
    push(out, line[i], 'plain');
    i++;
  }
}

function mdLine(line: string, out: Token[]) {
  if (/^\s{0,3}#{1,6}\s/.test(line)) return push(out, line, 'heading');
  if (/^\s*```/.test(line)) return push(out, line, 'meta');
  if (/^\s*>/.test(line)) return push(out, line, 'cm');
  const list = line.match(/^\s*([-*+]|\d+\.)\s/);
  let i = 0;
  if (list) {
    push(out, list[0], 'kw');
    i = list[0].length;
  }
  while (i < line.length) {
    const rest = line.slice(i);
    const m = rest.match(/^`[^`]*`/) ?? rest.match(/^\*\*[^*]+\*\*/) ?? rest.match(/^\[[^\]]*\]\([^)]*\)/);
    if (m) {
      push(out, m[0], m[0][0] === '`' ? 'str' : m[0][0] === '*' ? 'emph' : 'link');
      i += m[0].length;
      continue;
    }
    push(out, line[i], 'plain');
    i++;
  }
}

function yamlLine(line: string, out: Token[]) {
  const t = line.trimStart();
  if (t.startsWith('#')) return push(out, line, 'cm');
  const key = line.match(/^(\s*-?\s*)([^\s:#][^:#]*?)(:)(\s|$)/);
  let rest = line;
  if (key) {
    push(out, key[1], 'punct');
    push(out, key[2], 'prop');
    push(out, key[3], 'punct');
    rest = line.slice(key[1].length + key[2].length + 1);
  } else if (/^\s*-\s/.test(line)) {
    const m = line.match(/^\s*-\s/)!;
    push(out, m[0], 'punct');
    rest = line.slice(m[0].length);
  }
  valueTokens(rest, out);
}

function iniLine(line: string, out: Token[]) {
  const t = line.trimStart();
  if (t.startsWith('#') || t.startsWith(';')) return push(out, line, 'cm');
  if (/^\s*\[[^\]]*\]\s*$/.test(line)) return push(out, line, 'tag');
  const kv = line.match(/^(\s*)([^=:\s][^=:]*?)(\s*[=:]\s*)/);
  if (kv) {
    push(out, kv[1], 'plain');
    push(out, kv[2], 'prop');
    push(out, kv[3], 'punct');
    return valueTokens(line.slice(kv[0].length), out);
  }
  valueTokens(line, out);
}

/** right-hand side of yaml / ini: strings, numbers, booleans, trailing comments */
function valueTokens(s: string, out: Token[]) {
  let i = 0;
  while (i < s.length) {
    const rest = s.slice(i);
    if (/^\s#/.test(rest)) return push(out, rest, 'cm');
    if (s[i] === '"' || s[i] === "'") {
      const j = readString(s, i);
      push(out, s.slice(i, j), 'str');
      i = j;
      continue;
    }
    const w = rest.match(/^(true|false|yes|no|on|off|null|~)(?![\w-])/i);
    if (w && !/\w/.test(s[i - 1] ?? ' ')) {
      push(out, w[0], 'kw');
      i += w[0].length;
      continue;
    }
    const n = rest.match(NUM_RE);
    if (n && !/\w/.test(s[i - 1] ?? ' ')) {
      push(out, n[0], 'num');
      i += n[0].length;
      continue;
    }
    push(out, s[i], 'plain');
    i++;
  }
}

function cssLine(line: string, d: LangDef, out: Token[]) {
  const t = line.trimStart();
  if (/^(\/\*|\*)/.test(t) || t.startsWith('//')) return push(out, line, 'cm');
  const decl = line.match(/^(\s*)([\w-]+)(\s*:\s*)(?!:)/);
  if (decl && !/[{]\s*$/.test(line)) {
    push(out, decl[1], 'plain');
    push(out, decl[2], 'prop');
    push(out, decl[3], 'punct');
    let i = decl[0].length;
    while (i < line.length) {
      const rest = line.slice(i);
      const m = rest.match(/^#[\da-f]{3,8}\b/i) ?? rest.match(NUM_RE);
      if (m && !/[\w-]/.test(line[i - 1] ?? ' ')) {
        push(out, m[0], 'num');
        i += m[0].length;
        continue;
      }
      if (line[i] === '"' || line[i] === "'") {
        const j = readString(line, i);
        push(out, line.slice(i, j), 'str');
        i = j;
        continue;
      }
      const fn = rest.match(/^[\w-]+(?=\()/);
      if (fn) {
        push(out, fn[0], 'fn');
        i += fn[0].length;
        continue;
      }
      push(out, line[i], /[;,(){}]/.test(line[i]) ? 'punct' : 'plain');
      i++;
    }
    return;
  }
  // selectors and at-rules
  let i = 0;
  while (i < line.length) {
    const rest = line.slice(i);
    const at = rest.match(/^@[\w-]+/);
    if (at) {
      push(out, at[0], 'kw');
      i += at[0].length;
      continue;
    }
    const sel = rest.match(/^[.#&]?[\w-]+/);
    if (sel) {
      push(out, sel[0], sel[0][0] === '.' || sel[0][0] === '#' ? 'type' : 'tag');
      i += sel[0].length;
      continue;
    }
    push(out, line[i], /[{}(),:>+~]/.test(line[i]) ? 'punct' : 'plain');
    i++;
  }
  void d;
}

function genericLine(line: string, out: Token[]) {
  const t = line.trimStart();
  if (t.startsWith('#') || t.startsWith('//') || t.startsWith(';')) return push(out, line, 'cm');
  valueTokens(line, out);
}

export function tokenize(line: string, d: LangDef): Token[] {
  const out: Token[] = [];
  if (!line) return out;
  switch (d.mode) {
    case 'code':
      codeLine(line, d, out);
      break;
    case 'markup':
      markupLine(line, out);
      break;
    case 'md':
      mdLine(line, out);
      break;
    case 'yaml':
      yamlLine(line, out);
      break;
    case 'ini':
      iniLine(line, out);
      break;
    case 'css':
      cssLine(line, d, out);
      break;
    default:
      genericLine(line, out);
  }
  return out;
}
