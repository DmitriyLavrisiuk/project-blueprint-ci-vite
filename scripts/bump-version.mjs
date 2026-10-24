#!/usr/bin/env node
// Подъём версии перед выпуском: номер — во все файлы, где он лежит, [Unreleased] в CHANGELOG
// становится разделом версии с датой. Коммит и тег не делает — они по команде владельца.
// Где лежит номер, кроме package.json и composer.json, — versionFiles в .docs-check.json,
// тот же список, по которому сверяет проверка docs. Если хоть что-то не так, не пишет ничего.
// Запуск из корня проекта: node scripts/bump-version.mjs <X.Y.Z | major | minor | patch> [--date ГГГГ-ММ-ДД]

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const read = (path) => readFileSync(join(ROOT, path), 'utf8');
const exists = (path) => existsSync(join(ROOT, path));
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function fail(message) {
  console.error(message);
  process.exit(1);
}

const [wanted, ...flags] = process.argv.slice(2);
// Дата — по часам машины; другой часовой пояс — через TZ или --date.
const date = flags.includes('--date') ? flags[flags.indexOf('--date') + 1] : new Date().toLocaleDateString('sv-SE');
if (!wanted) fail('Укажи версию: X.Y.Z, major, minor или patch.');
if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) fail(`Дата — ГГГГ-ММ-ДД, а не ${date}.`);
if (!exists('CHANGELOG.md')) fail('Нет CHANGELOG.md.');

// Текущая версия — последняя выпущенная в CHANGELOG; выпусков нет — 0.0.0, и первый minor даёт 0.1.0.
const changelog = read('CHANGELOG.md');
const current = changelog.match(/^## \[(\d+\.\d+\.\d+)\]/m)?.[1] ?? '0.0.0';
const [major, minor, patch] = current.split('.').map(Number);
const next = { major: `${major + 1}.0.0`, minor: `${major}.${minor + 1}.0`, patch: `${major}.${minor}.${patch + 1}` }[wanted] ?? wanted;
if (!/^\d+\.\d+\.\d+$/.test(next)) fail(`Версия — X.Y.Z, major, minor или patch, а не ${wanted}.`);
const newer = next.split('.').map(Number).reduce((result, part, index) => result || Math.sign(part - [major, minor, patch][index]), 0) > 0;
if (!newer) fail(`Новая версия ${next} должна быть больше текущей ${current}.`);

const problems = [];
const changes = new Map();

// [Unreleased] → пустой [Unreleased] и раздел версии с прежними записями.
const unreleased = changelog.match(/^## \[Unreleased\][^\n]*\n([\s\S]*?)(?=^## \[|(?![\s\S]))/m);
if (!unreleased) problems.push('CHANGELOG.md: нет раздела [Unreleased]');
else if (!/^- /m.test(unreleased[1])) problems.push('CHANGELOG.md: в [Unreleased] нет записей — выпускать нечего');
else changes.set('CHANGELOG.md', changelog.replace(unreleased[0], () => `## [Unreleased]\n\n## [${next}] — ${date}\n${unreleased[1]}`));

const config = exists('.docs-check.json') ? JSON.parse(read('.docs-check.json')) : {};
const files = [
  ...['package.json', 'composer.json'].filter((file) => exists(file) && JSON.parse(read(file)).version !== undefined).map((file) => ({ file, json: 'version' })),
  ...(config.versionFiles ?? []),
];
for (const { file, json, header } of files) {
  if (!exists(file)) {
    problems.push(`${file}: нет файла`);
    continue;
  }
  const pattern = json ? new RegExp(`("${escape(json)}"\\s*:\\s*")[^"]*(")`) : new RegExp(`^([\\s*#/]*${escape(header)}:\\s*)\\S+`, 'm');
  const text = read(file);
  if (!pattern.test(text)) problems.push(`${file}: нет поля версии ${json ?? header}`);
  else changes.set(file, text.replace(pattern, json ? `$1${next}$2` : `$1${next}`));
}

if (problems.length) fail(`Ничего не изменено:\n- ${problems.join('\n- ')}`);

for (const [file, text] of changes) writeFileSync(join(ROOT, file), text);
console.log(`Версия ${next} (была ${current}), дата ${date}:`);
for (const file of changes.keys()) console.log(`- ${file}`);
console.log(`Дальше: раздел версии в ROADMAP, STATUS, release-qa; коммит и тег v${next} — по команде владельца.`);
