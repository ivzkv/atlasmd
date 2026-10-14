# atlasmd — Jira / Confluence → Markdown (read-only CLI)

[English](README.md) · [Українська](README.uk.md) · **Русский**

Читает тикеты Jira и страницы Confluence (wiki) через REST API — и self-hosted Server/Data Center (Personal Access
Token), и Atlassian Cloud (`*.atlassian.net`, API token + email) — и сохраняет их в Markdown.
Ничего в Jira/Confluence не меняет.

Нужен Node ≥ 23.8. Зависимости — только конвертеры в Markdown: `turndown` (+gfm для таблиц) для страниц wiki
и `mammoth` для `.docx`.

> Вывод инструмента (stdout, `.md`-файлы, отчёты `track`) — на английском. Этот файл — перевод [README.md](README.md);
> если они расходятся, верен английский.

## Подключение к проекту

Пакет ставится как dev-зависимость проекта — после `git clone` + `npm install` инструмент есть у всех, кто работает с проектом:

```
npm i -D "git+https://<git-host>/<owner>/atlasmd.git#semver:^1.0.0"   # при установке собирается сам (prepare)
```

Во время разработки самого atlasmd вместо этого подключают локальную копию (в package.json проекта ничего не пишется):

```
cd atlasmd && npm install && npm link       # один раз
cd <проект> && npm link atlasmd             # повторять после каждого npm install / npm ci в проекте
```

Запуск — `npx --no atlasmd <команда>`. `--no` обязателен: без него, если пакет не установлен, npx скачает
из публичного npm любой пакет с таким именем.

Каждый, кто работает с проектом, один раз выполняет из корня проекта:

```
npx --no atlasmd init     # создаёт .jira/.env из шаблона, .jira/.gitignore ("*") и skill для Claude Code
```

вписывает свои токены в `.jira/.env` и проверяет доступ: `npx --no atlasmd probe`.

Настройки и результаты лежат в проекте, а не в пакете:

```
<корень проекта>/.jira/.env    URL и токены          (другой путь — JIRA_ENV_FILE)
<корень проекта>/.jira/out/    тикеты, wiki, track   (другой путь — JIRA_OUT_DIR)
```

Команды запускаются из корня проекта: инструмент берёт `.jira/` только в текущей папке, вверх не ищет
(из другой папки — ошибка с точным путём). Другой путь можно задать только явно: `JIRA_ENV_FILE`, `JIRA_OUT_DIR`.
`probe` печатает, какие файлы использованы. Вся папка `.jira/` вне git благодаря собственному `.gitignore` —
`.gitignore` проекта править не нужно.

### Claude Code

- `npx --no atlasmd skill` (делает и `init`) кладёт в проект `.claude/skills/atlasmd/SKILL.md` из установленной
  версии пакета. После `npm update atlasmd` — повторить и закоммитить diff. `probe` показывает, актуален ли skill.
- Запретить Claude доступ к токенам в `.claude/settings.json` проекта:
  `"permissions": { "deny": ["Read(/.jira/.env*)", "Edit(/.jira/.env*)"] }`. `skill` напомнит, если правила нет.

## Настройка

1. Заполнить `.jira/.env` (создаёт `npx --no atlasmd init`) — один из вариантов (можно разные для Jira и Confluence):
   - **Server/DC:** `JIRA_BASE_URL` + `JIRA_TOKEN`, `CONFLUENCE_BASE_URL` + `CONFLUENCE_TOKEN` — отдельные PAT из профилей
     Jira и Confluence, `Authorization: Bearer`. Email не задавать.
   - **Cloud:** URL задаются явно, как есть — `JIRA_BASE_URL=https://<site>.atlassian.net`,
     `CONFLUENCE_BASE_URL=https://<site>.atlassian.net/wiki`; `ATLASSIAN_EMAIL` + `ATLASSIAN_API_TOKEN` — один токен
     из id.atlassian.com → Security → API tokens на оба сервиса, `Authorization: Basic`. Доступ — ровно тот,
     что у этой учётной записи в браузере.
   - Режим определяется так: есть email (`<SERVICE>_EMAIL` / `ATLASSIAN_EMAIL`) → basic, нет → bearer;
     принудительно — `JIRA_AUTH` / `CONFLUENCE_AUTH` = `bearer` | `basic`. `probe` печатает, какой режим применён.

   Переменные, уже заданные в окружении процесса, важнее `.env` (удобно для CI).
2. HTTPS доверяет сертификатам из хранилища ОС (`--use-system-ca`). `JIRA_INSECURE_TLS=1` — только для self-hosted,
   если цепочка заканчивается корпоративным Root CA, которого нет и там. Флаг отключает проверку TLS только для этого процесса.
3. Проверить доступ: `npx --no atlasmd probe`.

Отличия Cloud, которые клиент обрабатывает сам: JQL-поиск через `/rest/api/3/search/jql` (старый `/rest/api/2/search`
в Cloud отключён; `total` не возвращается — в поиске «N+», количество в probe — `approximate-count`), у пользователей
`accountId` вместо `name`/`username`. Базовые URL клиент не меняет.

## Команды

```
atlasmd version                                     # версия инструмента (есть и в первой строке probe); не --version: его перехватывает npx
atlasmd init                                        # подключить проект: .jira/.env, .jira/.gitignore, skill для Claude Code
atlasmd skill                                       # установить / обновить .claude/skills/atlasmd/SKILL.md из этой версии
atlasmd probe                                       # версия, пользователь, права, проекты, доски, поля, вложения, Confluence

atlasmd jira issue PROJ-123                         # тикет: поля, описание, комментарии, ссылки (в т.ч. на wiki) → stdout и .jira/out/PROJ-123/PROJ-123.md;
                                                    #   картинки тикета скачиваются и видны в .md (в описании/комментариях — на своих местах)
atlasmd jira issue PROJ-123 --attachments           # то же + все вложения рядом, в .md — ссылки на них (.docx → ещё и .md)
atlasmd jira search "project = PROJ AND resolution = Unresolved" 50
atlasmd jira attachments PROJ-123                   # вложения в .jira/out/PROJ-123/, .docx → ещё и .md (картинки из .docx — файлами рядом)

atlasmd wiki page 123456                            # страница wiki → Markdown + комментарии (inline с выделенным текстом)
atlasmd wiki page "https://wiki.example.com/spaces/SPACE/pages/123456/..." --attachments   # изображения страницы скачиваются всегда, --attachments — остальные вложения
atlasmd wiki search "release notes" 30 --space SPACE   # поиск страниц wiki: текст или готовый CQL

atlasmd docx "<путь>.docx"                          # локальный .docx → .md рядом (напр. ТЗ из архивов вложений)
```

`wiki page` принимает pageId, `viewpage.action?pageId=…`, `/spaces/X/pages/<id>/…` или `/display/SPACE/Title`.
Результат — в stdout и в `.jira/out/wiki/<pageId>/`.

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

Снимок — `.jira/out/track/state.json`, отчёты — `.jira/out/track/reports/<дата_время>.md`.
Динамические вставки макроса Jira в страницах wiki (название/статус тикета) при сравнении игнорируются.

### Ограничения

- Удалённое **до** взятия под наблюдение не восстановить: Confluence сам удаляет/сливает версии страниц
  (в истории страницы могут быть пропущены номера версий), Jira не хранит удалённые комментарии.
- Старый текст отредактированного комментария Jira есть только тогда, когда комментарий уже был в снимке
  (Jira хранит только дату правки); с `--since` без снимка видно, что и когда изменено, и текущий текст.
- Удаление комментария в Jira видно только между запусками `track` (не через `--since`).
- Кто просматривал тикет/страницу, API не отдаёт.
- `track` не запускается сам — его вызывают в момент синка.

## Безопасность

- На 401, редирект на SSO/логин или CAPTCHA клиент останавливается сразу, без повторов (self-hosted Jira после
  нескольких 401 закрывает REST за CAPTCHA).
- Токены не логируются. Если токен засветился — отозвать в профиле Jira/Confluence → Personal Access Tokens
  (Server/DC) или на id.atlassian.com → Security → API tokens (Cloud; один токен открывает оба сервиса).

## Разработка

```
npm install                  # заодно собирает dist/ (prepare); в проектах через npm link изменения видны после npm run build
npm run dev -- issue X-1     # запуск из src/*.ts без сборки (нативное стирание типов Node)
npm run typecheck
npm run build                # dist/ — то, что запускает bin/atlasmd.js
```

Версии — git-теги `vX.Y.Z`, и `version` в package.json должна с ними совпадать (именно её печатают `atlasmd version`
и `probe`). Релиз: `npm version minor` (или `patch` / `major` — поднимает версию, коммитит и ставит тег) →
`git push --follow-tags`. В проектах: `"atlasmd": "git+https://…/atlasmd.git#semver:^1.0.0"`; обновление —
`npm update atlasmd`, `npx --no atlasmd skill`, коммит package-lock.json и skill. Ломающие изменения (команды, формат
`.jira/.env`) — только в новой major-версии.

## Лицензия

[MIT](LICENSE)
