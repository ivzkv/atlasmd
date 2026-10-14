# atlasmd

[English](README.md) · [Українська](README.uk.md) · **Русский**

**Дайте своему coding-агенту безопасный read-only доступ к Jira и Confluence.**

atlasmd — небольшой CLI, который превращает тикеты Jira и страницы Confluence в чистые Markdown-файлы, которые может
читать AI-агент. Он создан прежде всего для агентов (с готовым skill для [Claude Code](https://claude.com/claude-code)),
но так же удобен и вручную. Работает с self-hosted Server/Data Center и с Atlassian Cloud.

> Вывод инструмента (stdout, `.md`-файлы, отчёты `track`) — на английском. Этот файл — перевод [README.md](README.md);
> если они расходятся, верен английский.

## Зачем atlasmd

- **Только чтение — по замыслу.** Операций записи в Jira или Confluence нет вообще — агенту можно дать доступ,
  не опасаясь, что он закроет тикет или изменит страницу.
- **Markdown, а не JSON.** Тикет или страница становится чистым Markdown — таблицы, код, упоминания по именам,
  комментарии с авторами и датами — вместо тысяч токенов сырого REST-ответа.
- **Файлы, к которым агент может вернуться.** Всё сохраняется по предсказуемым путям (`.atlasmd/out/<KEY>/<KEY>.md`),
  так что агент перечитывает файл, а не повторяет запрос.
- **Картинки и вложения — локально.** Изображения скачиваются и подставляются относительными ссылками, так что
  мультимодальный агент их видит; вложения `.docx` конвертируются в `.md`.
- **Секреты не попадают в контекст.** Токены никогда не печатаются; skill и правило запрета не подпускают агента
  к `.atlasmd/.env`.
- **Падает сразу, без повторов.** На 401, CAPTCHA или редирект на SSO останавливается сразу — агент в цикле
  не заблокирует учётную запись повторными попытками.
- **Ошибки подсказывают следующий шаг.** В ошибке — точный путь и команда, которую нужно выполнить
  (`… or create it: node .atlasmd/tool/bin/atlasmd.js init`), так что агент исправляется сам.
- **«Что изменилось?» — из коробки.** `track` показывает, что изменилось в тикетах и связанных страницах wiki
  с прошлого запуска или с даты — готовый ответ на один из самых частых вопросов.
- **Собственный skill для Claude Code.** Инструкции для агента идут вместе с пакетом, соответствуют его версии,
  ставятся одной командой, а `probe` подскажет, когда они устарели.

## Как это выглядит

```
> что в PROJ-123 и что изменилось со вчера?

$ node .atlasmd/tool/bin/atlasmd.js jira issue PROJ-123
$ node .atlasmd/tool/bin/atlasmd.js track PROJ-123 --since 2026-10-13
→ агент читает .atlasmd/out/PROJ-123/PROJ-123.md и отчёт track и отвечает
```

## Быстрый старт

Нужны Node ≥ 23.8, git и npm. Из корня вашего проекта:

```
git -c advice.detachedHead=false clone -q --depth 1 --branch vX.Y.Z https://github.com/ivzkv/atlasmd.git .atlasmd/tool
npm ci --omit=dev --ignore-scripts --prefix .atlasmd/tool
node .atlasmd/tool/bin/atlasmd.js init
node .atlasmd/tool/bin/atlasmd.js probe
```

1. скачать исходники тега `vX.Y.Z` в `.atlasmd/tool/`;
2. поставить туда их runtime-зависимости (без сборки: исходники запускаются напрямую через стирание типов Node);
3. создать `.atlasmd/.env`, закрепить `vX.Y.Z` в `.atlasmd/version`, поставить skill;
4. вписать свои URL и токен в `.atlasmd/.env`;
5. проверить доступ.

`vX.Y.Z` — тег релиза (см. [Releases](https://github.com/ivzkv/atlasmd/releases)). В сам проект ничего не ставится —
ни package.json, ни node_modules в его корне: инструмент лежит в `.atlasmd/tool/` (вне git), а `.atlasmd/version`
(одна строка, напр. `1.0.3`) закрепляет его версию. Закоммитьте `.atlasmd/version`, `.atlasmd/.gitignore` и skill: у всех
в проекте будет одна версия — `.atlasmd/tool/` Claude скачает сам при первом использовании (шаги 1–2, они описаны
в skill), — а каждый один раз запускает `init` и вписывает свой токен.

Всё лежит в проекте; у `.atlasmd/` свой `.gitignore`, который держит вне git всё, кроме закреплённой версии
(`.gitignore` проекта править не нужно):

```
<корень проекта>/.atlasmd/version  закреплённая версия    (в git)
<корень проекта>/.atlasmd/tool/    инструмент этой версии (каждый скачивает сам)
<корень проекта>/.atlasmd/.env     URL и токены           (другой путь — JIRA_ENV_FILE)
<корень проекта>/.atlasmd/out/     тикеты, wiki, track    (другой путь — JIRA_OUT_DIR)
```

Инструмент берёт `.atlasmd/` только в текущей папке и вверх не ищет — запускайте из корня проекта (из другой папки —
ошибка с точным путём). `probe` печатает, какие файлы использованы.

## Использование с Claude Code

- `skill` (делает и `init`) закрепляет за проектом версию, которая его запустила (`.atlasmd/version`), и ставит
  `.claude/skills/atlasmd/SKILL.md` этой версии. Skill объясняет Claude, когда и как пользоваться инструментом, что
  делать при сбоях и чего не трогать никогда. Версии в нём нет — это `skills/atlasmd/SKILL.md` из этого репозитория
  как есть, поэтому в проекте он меняется, только когда меняется его текст здесь.
- Перевести проект на другую версию (или попросить об этом Claude): вписать её в `.atlasmd/version`, удалить
  `.atlasmd/tool/`, скачать заново (шаги 1–2), запустить `skill`, закоммитить diff. Пока копия не скачана заново,
  каждая команда предупреждает, что закреплённая и запущенная версии разные; `probe` печатает обе и совпадает ли skill.
- Запретить Claude доступ к токенам в `.claude/settings.json` проекта:
  `"permissions": { "deny": ["Read(/.atlasmd/.env*)", "Edit(/.atlasmd/.env*)"] }`. `skill` напомнит, если правила нет.

Другие агенты могут пользоваться теми же командами — подойдёт любой агент, который умеет запускать команду
в shell и читать файл.

## Команды

`atlasmd` ниже — сокращение для `node .atlasmd/tool/bin/atlasmd.js` (запуск из корня проекта).

```
atlasmd jira issue PROJ-123                         # тикет: поля, описание, комментарии, ссылки (в т.ч. на wiki) → stdout и .atlasmd/out/PROJ-123/PROJ-123.md;
                                                    #   картинки тикета скачиваются и видны в .md (в описании/комментариях — на своих местах)
atlasmd jira issue PROJ-123 --attachments           # то же + все вложения рядом, в .md — ссылки на них (.docx → ещё и .md)
atlasmd jira search "project = PROJ AND resolution = Unresolved" 50
atlasmd jira attachments PROJ-123                   # вложения в .atlasmd/out/PROJ-123/, .docx → ещё и .md (картинки из .docx — файлами рядом)

atlasmd wiki page 123456                            # страница wiki → Markdown + комментарии (inline с выделенным текстом)
atlasmd wiki page "https://wiki.example.com/spaces/SPACE/pages/123456/..." --attachments   # изображения страницы скачиваются всегда, --attachments — остальные вложения
atlasmd wiki search "release notes" 30 --space SPACE   # поиск страниц wiki: текст или готовый CQL
atlasmd wiki search "title ~ release" --cql          # CQL распознаётся по условию «поле оператор» (title = …, text ~ …);
                                                    #   --cql / --text — задать явно; свой ORDER BY в CQL сохраняется

atlasmd probe                                       # версия, пользователь, права, проекты, доски, поля, вложения, Confluence
atlasmd docx "<путь>.docx"                          # локальный .docx → .md рядом (напр. ТЗ из архивов вложений)
atlasmd init                                        # подключить проект: .atlasmd/.env, .atlasmd/.gitignore, skill для Claude Code
atlasmd skill                                       # установить / обновить .claude/skills/atlasmd/SKILL.md из этой версии
atlasmd version                                     # версия инструмента (есть и в первой строке probe)
```

`atlasmd jira` или `atlasmd wiki` без подкоманды показывает команды своей группы. `wiki page` принимает pageId,
`viewpage.action?pageId=…`, `/spaces/X/pages/<id>/…` или `/display/SPACE/Title`; результат — в stdout и в
`.atlasmd/out/wiki/<pageId>/`.

Даты: в выводе есть даты создания и правки комментариев, версии и даты вложений wiki. Скачанные файлы получают
на диске реальную дату из Jira (дата загрузки вложения) / Confluence (дата версии), а не момент скачивания.

## Отслеживание изменений (`track`)

```
atlasmd track PROJ-123 PROJ-456                     # взять под наблюдение / проверить эти тикеты
atlasmd track --jql "project = PROJ AND status = \"In Progress\""
atlasmd track --page 123456                         # отдельная страница wiki без тикета
atlasmd track                                       # проверить всё, что под наблюдением
atlasmd track PROJ-123 --since 2026-01-31           # изменения с даты (работает и без предыдущего снимка)
atlasmd track --remove PROJ-456                     # снять с наблюдения
```

Первый запуск фиксирует базовую линию, следующие показывают, что изменилось с предыдущего:

- **Jira** — из changelog тикета (каждое изменение поля с автором и датой; длинные поля, напр. описание, — diff),
  комментарии новые / изменённые (diff со снимком) / удалённые, новые и пропавшие ссылки на страницы wiki.
- **Wiki** — страницы, на которые ссылается тикет (remote links + URL в описании и комментариях), или заданные `--page`:
  все новые версии (кто, когда, комментарий к версии; пропущенные номера = удалённые/слитые в истории Confluence),
  diff текста между версиями, скачанными из самого Confluence (если старую версию удалили — из снимка),
  пословно «было → стало» для правок внутри длинных строк; комментарии новые / изменённые / resolved↔open / удалённые;
  вложения новые / новая версия / удалённые.

Снимок — `.atlasmd/out/track/state.json`, отчёты — `.atlasmd/out/track/reports/<дата_время>.md`.
Динамические вставки макроса Jira в страницах wiki (название/статус тикета) при сравнении игнорируются.

### Ограничения

- Удалённое **до** взятия под наблюдение не восстановить: Confluence сам удаляет/сливает версии страниц
  (в истории страницы могут быть пропущены номера версий), Jira не хранит удалённые комментарии.
- Старый текст отредактированного комментария Jira есть только тогда, когда комментарий уже был в снимке
  (Jira хранит только дату правки); с `--since` без снимка видно, что и когда изменено, и текущий текст.
- Удаление комментария в Jira видно только между запусками `track` (не через `--since`).
- Кто просматривал тикет/страницу, API не отдаёт.
- `track` не запускается сам — его вызывают в момент синка.

## Настройка

`.atlasmd/.env` (создаёт `init` из [env.example](env.example)) — один из вариантов; для Jira и Confluence
могут быть разные:

- **Server/DC:** `JIRA_BASE_URL` + `JIRA_TOKEN`, `CONFLUENCE_BASE_URL` + `CONFLUENCE_TOKEN` — отдельные PAT из профилей
  Jira и Confluence, `Authorization: Bearer`. Email не задавать.
- **Cloud:** URL задаются явно, как есть — `JIRA_BASE_URL=https://<site>.atlassian.net`,
  `CONFLUENCE_BASE_URL=https://<site>.atlassian.net/wiki`; `ATLASSIAN_EMAIL` + `ATLASSIAN_API_TOKEN` — один токен
  из id.atlassian.com → Security → API tokens на оба сервиса, `Authorization: Basic`. Доступ — ровно тот,
  что у этой учётной записи в браузере.
- Режим определяется так: есть email (`<SERVICE>_EMAIL` / `ATLASSIAN_EMAIL`) → basic, нет → bearer;
  принудительно — `JIRA_AUTH` / `CONFLUENCE_AUTH` = `bearer` | `basic`. `probe` печатает, какой режим применён.

Переменные, уже заданные в окружении процесса, важнее `.env` (удобно для CI).

HTTPS доверяет сертификатам из хранилища ОС (`--use-system-ca`). `JIRA_INSECURE_TLS=1` — только для self-hosted,
если цепочка заканчивается корпоративным Root CA, которого нет и там; отключает проверку TLS только для этого процесса.

<details>
<summary>Отличия Cloud, которые клиент обрабатывает сам</summary>

JQL-поиск через `/rest/api/3/search/jql` (старый `/rest/api/2/search` в Cloud отключён; `total` не возвращается —
в поиске «N+», количество в probe — `approximate-count`), у пользователей `accountId` вместо `name`/`username`.
Базовые URL клиент не меняет.

</details>

## Безопасность

- Никаких запросов на запись в Jira или Confluence — только чтение.
- На 401, редирект на SSO/логин или CAPTCHA клиент останавливается сразу, без повторов (self-hosted Jira после
  нескольких 401 закрывает REST за CAPTCHA).
- Токены не логируются. Если токен засветился — отозвать в профиле Jira/Confluence → Personal Access Tokens
  (Server/DC) или на id.atlassian.com → Security → API tokens (Cloud; один токен открывает оба сервиса).

## Разработка

```
npm install                    # заодно собирает dist/ (prepare)
npm run dev -- jira issue X-1  # запуск из src/*.ts без сборки (нативное стирание типов Node)
npm run typecheck
npm run build                  # dist/ — собранный пакет; копия исходников (этот репозиторий, .atlasmd/tool) запускает src/ напрямую
```

Чтобы попробовать локальные изменения в проекте, запустите рабочую копию из корня проекта (она запускает `src/`
напрямую, без сборки; `.atlasmd/tool/` проекта остаётся как есть):

```
node <путь к atlasmd>/bin/atlasmd.js jira issue X-1
```

Зависимости — только конвертеры в Markdown: `turndown`
(+gfm для таблиц) и `mammoth` для `.docx`.

## Релизы

Версии — git-теги `vX.Y.Z`; `version` в package.json — то, что печатают `atlasmd version` и `probe`. Теги создаёт CI,
вручную их не ставить:

```
npm version minor --no-git-tag-version    # или patch / major; обновляет package.json и package-lock.json
git commit -am "Release 1.1.0" && git push
git push origin main:release              # .github/workflows/release.yml: проверки → тег v1.1.0 + GitHub Release
```

Workflow падает, ничего не публикуя, если тег уже есть (версию не подняли) или проверки не прошли. В проектах:
новая версия в `.atlasmd/version`, заново скачать `.atlasmd/tool/`, `skill`, коммит `.atlasmd/version` и skill. Ломающие изменения (команды, формат `.atlasmd/.env`) — только
в новой major-версии.

## Лицензия

[MIT](LICENSE)
