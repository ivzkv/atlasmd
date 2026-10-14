# atlasmd — Jira / Confluence → Markdown (read-only CLI)

[English](README.md) · **Українська** · [Русский](README.ru.md)

Читає тікети Jira і сторінки Confluence (wiki) через REST API — і self-hosted Server/Data Center (Personal Access
Token), і Atlassian Cloud (`*.atlassian.net`, API token + email) — і зберігає їх у Markdown.
Нічого в Jira/Confluence не змінює.

Потрібен Node ≥ 23.8. Залежності — лише конвертери в Markdown: `turndown` (+gfm для таблиць) для сторінок wiki
і `mammoth` для `.docx`.

> Вивід інструмента (stdout, `.md`-файли, звіти `track`) — англійською. Цей файл — переклад [README.md](README.md);
> якщо вони розходяться, правильний англійський.

## Підключення до проєкту

Пакет ставиться як dev-залежність проєкту — після `git clone` + `npm install` інструмент є в усіх, хто працює з проєктом:

```
npm i -D "git+https://<git-host>/<owner>/atlasmd.git#semver:^1.0.0"   # при встановленні збирається сам (prepare)
```

Під час розробки самого atlasmd замість цього підключають локальну копію (у package.json проєкту нічого не пишеться):

```
cd atlasmd && npm install && npm link       # один раз
cd <проєкт> && npm link atlasmd             # повторювати після кожного npm install / npm ci у проєкті
```

Запуск — `npx --no atlasmd <команда>`. `--no` обов'язковий: без нього, якщо пакет не встановлено, npx скачає
з публічного npm будь-який пакет з такою назвою.

Кожен, хто працює з проєктом, один раз виконує з кореня проєкту:

```
npx --no atlasmd init     # створює .jira/.env з шаблону, .jira/.gitignore ("*") і skill для Claude Code
```

вписує свої токени в `.jira/.env` і перевіряє доступ: `npx --no atlasmd probe`.

Налаштування й результати лежать у проєкті, а не в пакеті:

```
<корінь проєкту>/.jira/.env    URL і токени          (інший шлях — JIRA_ENV_FILE)
<корінь проєкту>/.jira/out/    тікети, wiki, track   (інший шлях — JIRA_OUT_DIR)
```

Команди запускаються з кореня проєкту: інструмент бере `.jira/` лише в поточній теці, вгору не шукає
(з іншої теки — помилка з точним шляхом). Інший шлях можна задати тільки явно: `JIRA_ENV_FILE`, `JIRA_OUT_DIR`.
`probe` друкує, які файли використано. Уся тека `.jira/` поза git завдяки власному `.gitignore` — `.gitignore`
проєкту правити не треба.

### Claude Code

- `npx --no atlasmd skill` (робить і `init`) кладе в проєкт `.claude/skills/atlasmd/SKILL.md` з установленої версії
  пакета. Після `npm update atlasmd` — повторити й закомітити diff. `probe` показує, чи skill актуальний.
- Заборонити Claude доступ до токенів у `.claude/settings.json` проєкту:
  `"permissions": { "deny": ["Read(/.jira/.env*)", "Edit(/.jira/.env*)"] }`. `skill` нагадає, якщо правила немає.

## Налаштування

1. Заповнити `.jira/.env` (створює `npx --no atlasmd init`) — один із варіантів (можна різні для Jira і Confluence):
   - **Server/DC:** `JIRA_BASE_URL` + `JIRA_TOKEN`, `CONFLUENCE_BASE_URL` + `CONFLUENCE_TOKEN` — окремі PAT з профілів
     Jira і Confluence, `Authorization: Bearer`. Email не задавати.
   - **Cloud:** URL задаються явно, як є — `JIRA_BASE_URL=https://<site>.atlassian.net`,
     `CONFLUENCE_BASE_URL=https://<site>.atlassian.net/wiki`; `ATLASSIAN_EMAIL` + `ATLASSIAN_API_TOKEN` — один токен
     з id.atlassian.com → Security → API tokens на обидва сервіси, `Authorization: Basic`. Доступ — рівно той,
     що в цього облікового запису в браузері.
   - Режим визначається так: є email (`<SERVICE>_EMAIL` / `ATLASSIAN_EMAIL`) → basic, немає → bearer;
     примусово — `JIRA_AUTH` / `CONFLUENCE_AUTH` = `bearer` | `basic`. `probe` друкує, який режим застосовано.

   Змінні, вже задані в оточенні процесу, мають пріоритет над `.env` (зручно для CI).
2. HTTPS довіряє сертифікатам зі сховища ОС (`--use-system-ca`). `JIRA_INSECURE_TLS=1` — лише для self-hosted, якщо
   ланцюжок закінчується корпоративним Root CA, якого немає і там. Прапорець вимикає перевірку TLS лише для цього процесу.
3. Перевірити доступ: `npx --no atlasmd probe`.

Відмінності Cloud, які клієнт обробляє сам: JQL-пошук через `/rest/api/3/search/jql` (старий `/rest/api/2/search`
у Cloud вимкнено; `total` не повертається — у пошуку «N+», кількість у probe — `approximate-count`), користувачі
мають `accountId` замість `name`/`username`. Базові URL клієнт не змінює.

## Команди

```
atlasmd version                                     # версія інструмента (є й у першому рядку probe); не --version: його перехоплює npx
atlasmd init                                        # підключити проєкт: .jira/.env, .jira/.gitignore, skill для Claude Code
atlasmd skill                                       # встановити / оновити .claude/skills/atlasmd/SKILL.md з цієї версії
atlasmd probe                                       # версія, користувач, права, проєкти, дошки, поля, вкладення, Confluence

atlasmd jira issue PROJ-123                         # тікет: поля, опис, коментарі, лінки (у т.ч. на wiki) → stdout і .jira/out/PROJ-123/PROJ-123.md;
                                                    #   картинки тікета качаються й видні в .md (в описі/коментарях — на своїх місцях)
atlasmd jira issue PROJ-123 --attachments           # те саме + усі вкладення поруч, у .md — посилання на них (.docx → ще й .md)
atlasmd jira search "project = PROJ AND resolution = Unresolved" 50
atlasmd jira attachments PROJ-123                   # вкладення в .jira/out/PROJ-123/, .docx → ще й .md (картинки з .docx — файлами поруч)

atlasmd wiki page 123456                            # сторінка wiki → Markdown + коментарі (inline з виділеним текстом)
atlasmd wiki page "https://wiki.example.com/spaces/SPACE/pages/123456/..." --attachments   # зображення сторінки качаються завжди, --attachments — решта вкладень
atlasmd wiki search "release notes" 30 --space SPACE   # пошук сторінок wiki: текст або готовий CQL

atlasmd docx "<шлях>.docx"                          # локальний .docx → .md поруч (напр. ТЗ з архівів вкладень)
```

`wiki page` приймає pageId, `viewpage.action?pageId=…`, `/spaces/X/pages/<id>/…` або `/display/SPACE/Title`.
Результат — у stdout і в `.jira/out/wiki/<pageId>/`.

Дати: у виводі є дати створення і правки коментарів, версії й дати вкладень wiki. Завантажені файли отримують
на диску реальну дату з Jira (дата завантаження вкладення) / Confluence (дата версії), а не момент завантаження.

## Відстеження змін (`track`)

```
atlasmd track PROJ-123 PROJ-456                     # взяти під нагляд / перевірити ці тікети
atlasmd track --jql "project = PROJ AND status = \"In Progress\""
atlasmd track --page 123456                         # окрема сторінка wiki без тікета
atlasmd track                                       # перевірити все, що під наглядом
atlasmd track PROJ-123 --since 2026-01-31           # зміни з дати (працює і без попереднього знімка)
atlasmd track --remove PROJ-456                     # зняти з нагляду
```

Перший запуск фіксує базову лінію, наступні показують, що змінилось з попереднього:

- **Jira** — з changelog тікета (кожна зміна поля з автором і датою; довгі поля, напр. опис, — diff),
  коментарі нові / змінені (diff зі знімком) / видалені, нові й зниклі посилання на сторінки wiki.
- **Wiki** — сторінки, на які посилається тікет (remote links + URL в описі й коментарях), або задані `--page`:
  усі нові версії (хто, коли, коментар до версії; пропущені номери = видалені/злиті в історії Confluence),
  diff тексту між версіями, завантаженими з самого Confluence (якщо стару версію видалили — зі знімка),
  пословно «було → стало» для правок усередині довгих рядків; коментарі нові / змінені / resolved↔open / видалені;
  вкладення нові / нова версія / видалені.

Знімок — `.jira/out/track/state.json`, звіти — `.jira/out/track/reports/<дата_час>.md`.
Динамічні вставки макросу Jira у сторінках wiki (назва/статус тікета) при порівнянні ігноруються.

### Обмеження

- Видалене **до** взяття під нагляд не відновити: Confluence сам видаляє/зливає версії сторінок
  (в історії сторінки можуть бути пропущені номери версій), Jira не зберігає видалені коментарі.
- Старий текст відредагованого коментаря Jira є лише тоді, коли коментар уже був у знімку
  (Jira зберігає тільки дату правки); з `--since` без знімка видно, що і коли змінено, і поточний текст.
- Видалення коментаря в Jira видно лише між запусками `track` (не через `--since`).
- Хто переглядав тікет/сторінку, API не віддає.
- `track` не запускається сам — його викликають у момент синку.

## Безпека

- На 401, редирект на SSO/логін або CAPTCHA клієнт зупиняється одразу, без повторів (self-hosted Jira після
  кількох 401 закриває REST за CAPTCHA).
- Токени не логуються. Якщо токен засвітився — відкликати в профілі Jira/Confluence → Personal Access Tokens
  (Server/DC) або на id.atlassian.com → Security → API tokens (Cloud; один токен відкриває обидва сервіси).

## Розробка

```
npm install                    # заодно збирає dist/ (prepare); у проєктах через npm link зміни видно після npm run build
npm run dev -- jira issue X-1  # запуск із src/*.ts без збірки (нативне стирання типів Node)
npm run typecheck
npm run build                  # dist/ — те, що запускає bin/atlasmd.js
```

## Релізи

Версії — git-теги `vX.Y.Z`; `version` у package.json — те, що друкують `atlasmd version` і `probe`. Теги створює CI,
вручну їх не ставити:

```
npm version minor --no-git-tag-version    # або patch / major; оновлює package.json і package-lock.json
git commit -am "Release 1.1.0" && git push
git push origin main:release              # .github/workflows/release.yml: перевірки → тег v1.1.0 + GitHub Release
```

Workflow падає, нічого не публікуючи, якщо тег уже є (версію не підняли) або перевірки не пройшли. У проєктах:
`"atlasmd": "git+https://github.com/ivzkv/atlasmd.git#semver:^1.0.0"`; оновлення — `npm update atlasmd`,
`npx --no atlasmd skill`, коміт package-lock.json і skill. Ламаючі зміни (команди, формат `.jira/.env`) — лише в новій
major-версії.

## Ліцензія

[MIT](LICENSE)
