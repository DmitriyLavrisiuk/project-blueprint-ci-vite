#!/bin/sh
# Форматирует файл после правки. Путь приходит JSON на stdin (tool_input.file_path);
# форматтеры стека — исполняемые файлы в .claude/hooks/format.d/, каждый получает путь
# и сам решает по расширению, его ли это файл. Сбой форматтера правку не отменяет.

file=$(node -e 'let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => { try { process.stdout.write(JSON.parse(s).tool_input?.file_path ?? ""); } catch {} });')
[ -n "$file" ] && [ -f "$file" ] || exit 0
cd "$CLAUDE_PROJECT_DIR" || exit 0
for formatter in .claude/hooks/format.d/*; do
  [ -x "$formatter" ] && "$formatter" "$file" >/dev/null 2>&1
done
exit 0
