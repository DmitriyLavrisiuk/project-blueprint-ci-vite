#!/usr/bin/env node
// Проверка документации: ссылки, якоря и упоминания ведут на существующее, документы
// держат правила ведения из docs/README.md, номер версии сходится везде.
// Проектное — какие папки считать кодом, какие имена искать в коде, где лежит номер
// версии — задаёт необязательный .docs-check.json в корне. Запуск из корня проекта:
// node scripts/check-docs.mjs

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';

const ROOT = process.cwd();
const config = existsSync(join(ROOT, '.docs-check.json')) ? JSON.parse(read('.docs-check.json')) : {};
const limits = { status: 50, line: 600, changelogEntry: 600, repeat: 60, ...config.limits };
// Где искать файлы из упоминаний: корень и, например, папки темы и плагина.
const roots = config.roots ?? ['.'];
// В плане упомянуты файлы, которых ещё нет; конфиг добавляет документы о других проектах.
const skipMentions = ['docs/ROADMAP.md', ...(config.skipMentions ?? [])];
// Копии чужих документов: проверяется только их место в карте.
const skipDocs = config.skipDocs ?? [];

const HEADER = /^<!--\nОТВЕЧАЕТ НА: .+\nСЮДА НЕ ПИСАТЬ: .+\nИСТОЧНИК ПРАВДЫ: .+\nОБНОВЛЯТЬ КОГДА: .+\n-->/;
const LINK = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const CODE_SPAN = /(`+)(.+?)\1/g;
const DOC_IN_CODE = /docs\/[\w./-]*\.md(?:#[\p{L}\p{N}_-]+)?/gu;
const DOC_NAME = /^[A-Z0-9]+(?:-[A-Z0-9]+)*\.md$/;
const FOLDER_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// ${{ … }} — выражения GitHub Actions, плейсхолдером не считаются.
const PLACEHOLDER = /(?<!\$)\{\{/;
const COMPOSER_COMMANDS = ['install', 'update', 'require', 'remove', 'audit', 'outdated', 'show', 'validate', 'dump-autoload', 'create-project', 'run', 'run-script'];

const problems = [];
const report = (where, message) => problems.push(`${where}  ${message}`);

function read(path) {
  return readFileSync(join(ROOT, path), 'utf8');
}

function walk(dir, skip = []) {
  if (!existsSync(join(ROOT, dir))) return [];
  if (!statSync(join(ROOT, dir)).isDirectory()) return [dir];
  return readdirSync(join(ROOT, dir)).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(join(ROOT, path)).isDirectory()) return skip.includes(name) ? [] : walk(path, skip);
    return [path];
  });
}

const listings = new Map();

// Путь существует ровно в таком написании: файловая система Mac не отличает STATUS.md от status.md.
function existsExact(path) {
  const clean = normalize(path).replace(/\/$/, '');
  if (clean.startsWith('..') || !existsSync(join(ROOT, clean))) return false;
  let dir = '';
  for (const segment of clean.split('/').filter((part) => part !== '' && part !== '.')) {
    if (!listings.has(dir)) listings.set(dir, readdirSync(join(ROOT, dir)));
    if (!listings.get(dir).includes(segment)) return false;
    dir = join(dir, segment);
  }
  return true;
}

// Строки вне блоков кода: блок — это образец, а не упоминание.
function proseLines(text) {
  let fenced = false;
  return text.split('\n').flatMap((line, index) => {
    if (line.trimStart().startsWith('```')) {
      fenced = !fenced;
      return [];
    }
    return fenced ? [] : [[line, index + 1]];
  });
}

const anchors = new Map();

// Якоря заголовков так, как их строит GitHub: нижний регистр, только буквы, цифры,
// пробелы, дефисы и подчёркивания, пробел — в дефис, повтор получает -1, -2…
function anchorsOf(doc) {
  if (!anchors.has(doc)) {
    const seen = new Map();
    const found = new Set();
    for (const [line] of proseLines(read(doc))) {
      const heading = line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/);
      if (!heading) continue;
      const base = heading[1]
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/<[^>]*>/g, '')
        .toLowerCase()
        .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
        .replace(/ /g, '-');
      const count = seen.get(base) ?? 0;
      found.add(count === 0 ? base : `${base}-${count}`);
      seen.set(base, count + 1);
    }
    anchors.set(doc, found);
  }
  return anchors.get(doc);
}

function linkProblem(from, target) {
  const [file, anchor] = target.split('#');
  const path = file === '' ? from : normalize(join(dirname(from), file));
  if (!existsExact(path)) return 'нет файла';
  if (anchor === undefined || !path.endsWith('.md')) return '';
  try {
    return anchorsOf(path).has(decodeURIComponent(anchor)) ? '' : 'нет раздела';
  } catch {
    return 'битый якорь';
  }
}

// Код из конфига — то, на что могут ссылаться упоминания; build/ генерируется и в чистом клоне его нет.
const CODE_EXT = /\.(?:php|js|mjs|css|json|html|sh|py|dist)$/;
const codeFiles = [
  ...['.claude/agents', '.claude/rules'].flatMap((dir) => walk(dir)).filter((path) => path.endsWith('.md')),
  ...(config.code ?? []).flatMap((dir) => walk(dir, ['node_modules', 'vendor', 'build'])).filter((path) => CODE_EXT.test(path)),
];
const codeText = (config.mentions ?? []).length ? codeFiles.map((path) => `${path}\n${read(path)}`).join('\n') : '';
const mentionPatterns = (config.mentions ?? []).map((pattern) => new RegExp(pattern, 'u'));
const scripts = (file) => (existsSync(join(ROOT, file)) ? Object.keys(JSON.parse(read(file)).scripts ?? {}) : []);
const npmScripts = scripts('package.json');
const composerScripts = scripts('composer.json');

function mentionProblem(mention) {
  const path = mention.replace(/:\d+$/, '').split('#')[0];
  // Путь проверяем, только если его первая папка есть в проекте: иначе это пример или чужой проект.
  // Многоточие и угловые скобки — знаки примера; .git/ — локальное состояние, его нет в дереве;
  // папка с / на конце — соглашение о месте, её может ещё не быть.
  if (path.includes('/') && !path.endsWith('/') && !/[\s<>*{}~$|…]|:\/\//.test(path) && !/^(?:\/|\.git\/)/.test(path)) {
    const first = normalize(path).split('/')[0];
    const base = roots.find((root) => existsExact(join(root, first)));
    if (base !== undefined && !roots.some((root) => existsExact(join(root, path)))) return 'нет файла';
  }
  for (const pattern of mentionPatterns) {
    if (pattern.test(mention) && !codeText.includes(mention.replace(/\(\)$/, '').replace(/^\./, ''))) return 'нет в коде';
  }
  return '';
}

// Команды: npm run X и composer X существуют в манифестах.
function commandProblems(line) {
  const found = [];
  for (const [, name] of line.matchAll(/npm run ([a-z0-9:-]+)/g)) {
    if (!npmScripts.includes(name)) found.push(`нет npm-скрипта ${name}`);
  }
  for (const [, name] of line.matchAll(/(?:^|`|\s)composer ([a-z][a-z:-]*)/g)) {
    if (!COMPOSER_COMMANDS.includes(name) && !composerScripts.includes(name)) found.push(`нет composer-скрипта ${name}`);
  }
  return found;
}

const docs = [
  ...['CLAUDE.md', '.claude/CLAUDE.md', 'README.md'].filter((path) => existsExact(path)),
  ...walk('docs').filter((path) => path.endsWith('.md')),
];

for (const doc of docs) {
  if (skipDocs.some((prefix) => doc.startsWith(prefix))) continue;
  const text = read(doc);
  const lines = text.split('\n');
  // Документ с фронтматтером — опубликованный текст: шапки и коротких пунктов от него не ждём.
  const published = text.startsWith('---\n');
  const checkMentions = !skipMentions.includes(doc);
  if (doc.startsWith('docs/') && !published && !HEADER.test(text)) report(`${doc}:1`, 'нет шапки из четырёх строк');
  if (doc === 'docs/STATUS.md' && lines.length - 1 > limits.status) report(`${doc}:${lines.length - 1}`, `длиннее ${limits.status} строк`);
  const headerEnd = text.startsWith('<!--') ? lines.findIndex((line) => line.includes('-->')) + 1 : 0;

  for (const [line, number] of proseLines(text)) {
    const where = `${doc}:${number}`;
    const bare = line.replace(CODE_SPAN, '');
    if (/^#{1,6}\s/.test(line) && /20\d\d-\d\d|`|\p{Extended_Pictographic}/u.test(line)) {
      report(where, 'в заголовке дата, код или эмодзи — сменится якорь');
    }
    if (!published && line.length > limits.line) report(where, `${line.length} знаков в строке — разбей на короткие пункты`);
    if (PLACEHOLDER.test(bare)) report(where, 'незаполненный плейсхолдер шаблона');
    if (!published && number > headerEnd && !line.startsWith('#')) {
      for (const [name] of bare.replace(/!?\[[^\]]*\]\([^)]*\)/g, '').matchAll(/(?<![\w/.-])(?:[\w.-]+\/)*[A-Za-z0-9][\w-]*\.md\b/g)) {
        report(where, `документ назван без ссылки: ${name}`);
      }
    }
    if (checkMentions) {
      for (const [, , mention] of line.matchAll(CODE_SPAN)) {
        const problem = mentionProblem(mention.trim());
        if (problem) report(where, `${problem}: ${mention.trim()}`);
      }
      for (const problem of commandProblems(line)) report(where, problem);
    }
    for (const [, target] of line.matchAll(LINK)) {
      if (/^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(target)) continue;
      const problem = linkProblem(doc, target);
      if (problem) report(where, `${problem}: ${target}`);
    }
  }
}

// Карта: в каждой папке docs/ есть README.md со ссылкой на каждый её документ и на README.md подпапок.
for (const dir of [...new Set(['docs', ...walk('docs').map(dirname)])]) {
  if (!existsSync(join(ROOT, dir))) continue;
  const readme = `${dir}/README.md`;
  if (!existsExact(readme)) {
    report(`${dir}/`, 'нет README.md');
    continue;
  }
  const listed = new Set(
    proseLines(read(readme)).flatMap(([line]) => [...line.matchAll(LINK)].map(([, target]) => normalize(join(dir, target.split('#')[0])))),
  );
  for (const name of readdirSync(join(ROOT, dir))) {
    const path = join(dir, name);
    if (statSync(join(ROOT, path)).isDirectory()) {
      if (!FOLDER_NAME.test(name)) report(`${path}/`, 'папка называется в lower-kebab');
      if (!listed.has(join(path, 'README.md'))) report(`${path}/README.md`, `нет ссылки из ${readme}`);
    } else if (name.endsWith('.md') && name !== 'README.md') {
      if (!DOC_NAME.test(name)) report(path, 'документ называется в UPPER-KEBAB-CASE.md');
      if (!listed.has(path)) report(path, `нет ссылки из ${readme}`);
    }
  }
}

// Документ компонента или страницы назван по коду: имя файла в нижнем регистре — {slug} в одном из путей namedDocs.
for (const { dir, match } of config.namedDocs ?? []) {
  for (const doc of walk(dir).filter((path) => path.endsWith('.md') && !path.endsWith('/README.md'))) {
    const paths = match.map((pattern) => pattern.replaceAll('{slug}', doc.split('/').pop().replace(/\.md$/, '').toLowerCase()));
    if (!paths.some((path) => existsExact(path))) report(`${doc}:1`, `нет в коде: ${paths.join(' или ')}`);
  }
}

const claude = ['CLAUDE.md', '.claude/CLAUDE.md'].filter((path) => existsExact(path));
if (claude.length && existsExact('docs/README.md') && !claude.some((path) => read(path).includes('docs/README.md'))) {
  report(`${claude[0]}:1`, 'не называет docs/README.md — карту документации');
}

// Код и агенты ссылаются на документы путём: такой путь должен куда-то вести.
for (const path of codeFiles) {
  read(path).split('\n').forEach((line, index) => {
    for (const [mention] of line.matchAll(DOC_IN_CODE)) {
      const problem = linkProblem('', mention);
      if (problem) report(`${path}:${index + 1}`, `${problem}: ${mention}`);
    }
  });
}

// Повторы: одно предложение или ячейка таблицы в двух файлах — у факта один дом, остальные ставят
// ссылку. Сравниваются docs, CLAUDE.md, README.md, агенты и правила; шапка, фронтматтер и блоки кода
// не в счёт. Повтор внутри файла не находка, фрагмент короче лимита без ссылок и путей — ссылка на
// дом, а не пересказ. Строки, которые обязаны стоять в нескольких файлах, — allowRepeats в конфиге.
const normText = (text) => text.replace(/[`*]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
const allowRepeats = (config.allowRepeats ?? []).map(normText);
const BLOCK_START = /^\s*$|^\s*(?:[-*+]|\d+\.)\s|^\s*\||^#{1,6}\s|^\s*>/;
const MARKER = /^\s*(?:[-*+]\s+|\d+\.\s+|#{1,6}\s+|>\s*)/;

function fragments(text) {
  const lines = text.split('\n');
  const skip = lines[0] === '---' ? lines.indexOf('---', 1) + 1 : text.startsWith('<!--') ? headerEndOf(lines) : 0;
  const found = [];
  let block = null;
  let fenced = false;
  const flush = () => {
    // Разметка снимается до разбивки: после «**Вывод.**» точка стоит перед звёздочками, а не перед пробелом.
    for (const part of normText(block?.text ?? '').split(block?.table ? /(?<=[.!?;])\s+|\|/ : /(?<=[.!?;])\s+/)) {
      const fragment = part.trim().replace(/[.!?;:,—\s]+$/, '');
      const own = fragment.replace(/\[[^\]]*\]\([^)]*\)/g, '').replace(/[\w./-]+\.[a-z]{1,5}\b/g, '');
      if (own.trim().length >= limits.repeat) found.push([fragment, block.line]);
    }
    block = null;
  };
  lines.forEach((line, index) => {
    if (index < skip) return;
    if (line.trimStart().startsWith('```')) {
      flush();
      fenced = !fenced;
      return;
    }
    if (fenced) return;
    if (BLOCK_START.test(line)) flush();
    if (line.trim() === '') return;
    if (block) block.text += ` ${line.trim()}`;
    else block = { line: index + 1, table: line.trimStart().startsWith('|'), text: line.replace(MARKER, '') };
  });
  flush();
  return found;
}

function headerEndOf(lines) {
  return lines.findIndex((line) => line.includes('-->')) + 1;
}

const places = new Map();
const compared = [
  ...docs.filter((doc) => !skipDocs.some((prefix) => doc.startsWith(prefix)) && !read(doc).startsWith('---\n')),
  ...['.claude/agents', '.claude/rules'].flatMap((dir) => walk(dir)).filter((path) => path.endsWith('.md')),
];
for (const file of compared) {
  for (const [fragment, line] of fragments(read(file))) {
    if (allowRepeats.some((allowed) => fragment.includes(allowed))) continue;
    if (!places.has(fragment)) places.set(fragment, []);
    if (!places.get(fragment).some((place) => place.file === file)) places.get(fragment).push({ file, line });
  }
}
for (const [fragment, [first, ...rest]] of places) {
  if (rest.length === 0) continue;
  const others = rest.map(({ file, line }) => `${file}:${line}`).join(', ');
  report(`${first.file}:${first.line}`, `повтор — у факта один дом, в остальных ссылка: ${others}; «${fragment.slice(0, 80)}${fragment.length > 80 ? '…' : ''}»`);
}

// ROADMAP — по версиям: разделы — версии, «Дальше» и «Без версии», подзаголовки без номеров.
if (existsExact('docs/ROADMAP.md')) {
  for (const [line, number] of proseLines(read('docs/ROADMAP.md'))) {
    if (/^## /.test(line) && !/^## (?:v\d+\.\d+ — .+|Дальше|Без версии)$/.test(line)) {
      report(`docs/ROADMAP.md:${number}`, 'раздел ROADMAP — версия «## vX.Y — цель», «Дальше» или «Без версии»');
    }
    if (/^###+ \d/.test(line)) report(`docs/ROADMAP.md:${number}`, 'подзаголовок версии — без номера');
  }
}

// CHANGELOG — история: проверяется только [Unreleased], то, что пишется сейчас.
let released = '';
if (existsExact('CHANGELOG.md')) {
  const lines = read('CHANGELOG.md').split('\n');
  const start = lines.findIndex((line) => /^## \[Unreleased\]/i.test(line));
  const next = lines.findIndex((line, index) => index > start && /^## \[/.test(line));
  released = (lines.find((line) => /^## \[\d/.test(line)) ?? '').match(/^## \[([^\]]+)\]/)?.[1] ?? '';
  if (start >= 0) {
    const end = next < 0 ? lines.length : next;
    for (let index = start + 1; index < end; index++) {
      const line = lines[index];
      const where = `CHANGELOG.md:${index + 1}`;
      if (PLACEHOLDER.test(line.replace(CODE_SPAN, ''))) report(where, 'незаполненный плейсхолдер шаблона');
      for (const [, target] of line.matchAll(LINK)) {
        if (/^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(target)) continue;
        const problem = linkProblem('CHANGELOG.md', target);
        if (problem) report(where, `${problem}: ${target}`);
      }
      if (!/^- /.test(line)) continue;
      let entry = line;
      for (let more = index + 1; more < end && lines[more].trim() !== '' && !/^(?:- |#)/.test(lines[more]); more++) entry += lines[more];
      if (entry.length > limits.changelogEntry) report(where, `запись длиннее ${limits.changelogEntry} знаков (${entry.length})`);
    }
  }
}

// Версия: манифесты и последняя выпущенная в CHANGELOG говорят одно и то же, последний тег — тоже.
// Тег может отставать: версия поднята, выпуск ждёт тега по команде владельца. Новее файлов он быть не может.
const versions = [];
for (const file of ['package.json', 'composer.json']) {
  if (existsExact(file)) {
    const version = JSON.parse(read(file)).version;
    if (version) versions.push([file, version]);
  }
}
// Файла ещё нет — например, темы в новом проекте — сверять нечего; подъём версии его потребует.
for (const { file, json, header } of (config.versionFiles ?? []).filter(({ file }) => existsExact(file))) {
  const text = read(file);
  const version = json ? JSON.parse(text)[json] : text.match(new RegExp(`^[\\s*#/]*${header}:\\s*(\\S+)`, 'm'))?.[1];
  if (version) versions.push([file, version]);
  else report(file, 'нет номера версии');
}
if (released) versions.push(['CHANGELOG.md', released]);
const compare = (a, b) => {
  const [x, y] = [a, b].map((version) => version.split('.').map(Number));
  return x.map((part, index) => part - y[index]).find((difference) => difference !== 0) ?? 0;
};
let pending = '';
if (new Set(versions.map(([, version]) => version)).size > 1) {
  report('версия', `не сходится: ${versions.map(([source, version]) => `${source} — ${version}`).join(', ')}`);
} else if (versions.length) {
  const version = versions[0][1];
  // Последний тег — наибольшая версия среди тегов, достижимых из HEAD: ближайший тег им бывает не всегда.
  let tag = '';
  try {
    const tags = execFileSync('git', ['tag', '--merged', 'HEAD', '--sort=-v:refname'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    tag = tags.split('\n').find((name) => /^v?\d+\.\d+\.\d+$/.test(name)) ?? '';
  } catch {
    // Не git-репозиторий — сверять не с чем.
  }
  if (tag && tag.replace(/^v/, '') !== version) {
    if (compare(version, tag.replace(/^v/, '')) > 0) pending = ` Версия ${version} ждёт тега.`;
    else report('версия', `в файлах ${version}, а последний тег — ${tag}`);
  }
}

if (problems.length) {
  console.error(problems.join('\n'));
  console.error(`\nПроблем в документации: ${problems.length}.`);
  process.exit(1);
}
console.log(`Документация сходится с кодом: проверено файлов — ${docs.length}.${pending}`);
