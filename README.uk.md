# atlasmd

[English](README.md) · **Українська** · [Русский](README.ru.md)

**Дайте своєму coding-агенту безпечний read-only доступ до Jira і Confluence.**

atlasmd — невеликий CLI, який перетворює тікети Jira і сторінки Confluence на чисті Markdown-файли, що їх може
читати AI-агент. Він створений насамперед для агентів (з готовим skill для [Claude Code](https://claude.com/claude-code)),
але так само зручний і вручну. Працює з self-hosted Server/Data Center і з Atlassian Cloud.

> Вивід інструмента (stdout, `.md`-файли, звіти `track`) — англійською. Цей файл — переклад [README.md](README.md);
> якщо вони розходяться, правильний англійський.

## Чому atlasmd

- **Лише читання — за задумом.** Жодної операції запису в Jira чи Confluence немає взагалі — агенту можна дати
  доступ, не боячись, що він закриє тікет чи змінить сторінку.
- **Markdown, а не JSON.** Тікет чи сторінка стає чистим Markdown — таблиці, код, згадки іменами, коментарі
  з авторами й датами — замість тисяч токенів сирої REST-відповіді.
- **Файли, до яких агент може повернутися.** Усе зберігається за передбачуваними шляхами (`.atlasmd/out/<KEY>/<KEY>.md`),
  тож агент перечитує файл, а не повторює запит.
- **Картинки й вкладення — локально.** Зображення скачуються й підставляються відносними посиланнями, тож
  мультимодальний агент їх бачить; вкладення `.docx` конвертуються в `.md`.
- **Секрети не потрапляють у контекст.** Токени ніколи не друкуються; skill і правило заборони не підпускають
  агента до `.atlasmd/.env`.
- **Падає одразу, без повторів.** На 401, CAPTCHA чи редирект на SSO зупиняється відразу — агент у циклі не
  заблокує обліковий запис повторними спробами.
- **Помилки підказують наступний крок.** У помилці — точний шлях і команда, яку виконати
  (`… or create it: node .atlasmd/tool/bin/atlasmd.js init`), тож агент виправляється сам.
- **«Що змінилось?» — з коробки.** `track` показує, що змінилось у тікетах і пов'язаних сторінках wiki з минулого
  запуску чи з дати — готова відповідь на одне з найчастіших питань.
- **Власний skill для Claude Code.** Інструкції для агента йдуть разом із пакетом, відповідають його версії,
  ставляться однією командою, а `probe` підкаже, коли вони застаріли.

## Як це виглядає

```
> що в PROJ-123 і що змінилось з учора?

$ node .atlasmd/tool/bin/atlasmd.js jira issue PROJ-123
$ node .atlasmd/tool/bin/atlasmd.js track PROJ-123 --since 2026-10-13
→ агент читає .atlasmd/out/PROJ-123/PROJ-123.md і звіт track та відповідає
```

## Швидкий старт

Потрібні Node ≥ 23.8, git і npm. З кореня вашого проєкту:

```
git -c advice.detachedHead=false clone -q --depth 1 --branch vX.Y.Z https://github.com/ivzkv/atlasmd.git .atlasmd/tool
npm ci --omit=dev --ignore-scripts --prefix .atlasmd/tool
node .atlasmd/tool/bin/atlasmd.js init
node .atlasmd/tool/bin/atlasmd.js probe
```

1. скачати сирці тегу `vX.Y.Z` у `.atlasmd/tool/`;
2. поставити туди їхні runtime-залежності (без збірки: сирці запускаються напряму через стирання типів Node);
3. створити `.atlasmd/.env`, закріпити `vX.Y.Z` у `.atlasmd/version`, поставити skill;
4. вписати свої URL і токен у `.atlasmd/.env`;
5. перевірити доступ.

Або доручіть це агенту — напишіть йому:

```
Завантаж https://raw.githubusercontent.com/ivzkv/atlasmd/vX.Y.Z/skills/atlasmd/SKILL.md
у .claude/skills/atlasmd/SKILL.md і виконай його розділ "First-time setup".
```

Skill проведе його тими самими кроками й додасть правило, що закриває агенту доступ до токенів. Завантаження
інструмента запускає код із GitHub, тож агенту може знадобитися ваш дозвіл: якщо його немає, агент дасть дві команди,
щоб ви запустили їх самі, або правила, що дозволяють саме ці команди.

`vX.Y.Z` — тег релізу (див. [Releases](https://github.com/ivzkv/atlasmd/releases)). У сам проєкт нічого не ставиться —
ні package.json, ні node_modules у його корені: інструмент лежить у `.atlasmd/tool/` (поза git), а `.atlasmd/version`
(один рядок, напр. `1.0.3`) закріплює його версію. Закомітьте `.atlasmd/version`, `.atlasmd/.gitignore` і skill: у всіх
у проєкті буде одна версія — `.atlasmd/tool/` Claude скачає сам під час першого використання (кроки 1–2, їх описано
в skill), — а кожен один раз запускає `init` і вписує свій токен.

Усе лежить у проєкті; у `.atlasmd/` свій `.gitignore`, який тримає поза git усе, крім закріпленої версії
(`.gitignore` проєкту правити не треба):

```
<корінь проєкту>/.atlasmd/version  закріплена версія      (у git)
<корінь проєкту>/.atlasmd/tool/    інструмент цієї версії (кожен качає сам)
<корінь проєкту>/.atlasmd/.env     URL і токени           (інший шлях — JIRA_ENV_FILE)
<корінь проєкту>/.atlasmd/out/     тікети, wiki, track    (інший шлях — JIRA_OUT_DIR)
```

Інструмент бере `.atlasmd/` лише в поточній теці й вгору не шукає — запускайте з кореня проєкту (з іншої теки —
помилка з точним шляхом). `probe` друкує, які файли використано.

## Використання з Claude Code

- `skill` (робить і `init`) закріплює за проєктом версію, що його запустила (`.atlasmd/version`), і ставить
  `.claude/skills/atlasmd/SKILL.md` цієї версії. Skill пояснює Claude, коли й як користуватися інструментом, що
  робити при збоях і чого не чіпати ніколи. Версії в ньому немає — це `skills/atlasmd/SKILL.md` з цього репозиторію
  як є, тож у проєкті він змінюється, лише коли змінюється його текст тут.
- Перевести проєкт на іншу версію (або попросити про це Claude): вписати її в `.atlasmd/version`, видалити
  `.atlasmd/tool/`, скачати заново (кроки 1–2), запустити `skill`, закомітити diff. Поки копію не скачано заново,
  кожна команда попереджає, що закріплена й запущена версії різні; `probe` друкує обидві і чи skill збігається.
- Заборонити Claude доступ до токенів у `.claude/settings.json` проєкту:
  `"permissions": { "deny": ["Read(/.atlasmd/.env*)", "Edit(/.atlasmd/.env*)"] }`. `skill` нагадає, якщо правила немає.

Інші агенти можуть користуватися тими самими командами — підійде будь-який агент, що вміє запускати команду
в shell і читати файл.

## Команди

`atlasmd` нижче — скорочення для `node .atlasmd/tool/bin/atlasmd.js` (запуск з кореня проєкту).

```
atlasmd jira issue PROJ-123                         # тікет: поля, опис, коментарі, лінки (у т.ч. на wiki) → stdout і .atlasmd/out/PROJ-123/PROJ-123.md;
                                                    #   картинки тікета качаються й видні в .md (в описі/коментарях — на своїх місцях)
atlasmd jira issue PROJ-123 --attachments           # те саме + усі вкладення поруч, у .md — посилання на них (.docx → ще й .md)
atlasmd jira search "project = PROJ AND resolution = Unresolved" 50
atlasmd jira attachments PROJ-123                   # вкладення в .atlasmd/out/PROJ-123/, .docx → ще й .md (картинки з .docx — файлами поруч)

atlasmd wiki page 123456                            # сторінка wiki → Markdown + коментарі (inline з виділеним текстом)
atlasmd wiki page "https://wiki.example.com/spaces/SPACE/pages/123456/..." --attachments   # зображення сторінки качаються завжди, --attachments — решта вкладень
atlasmd wiki search "release notes" 30 --space SPACE   # пошук сторінок wiki: текст або готовий CQL
atlasmd wiki search "title ~ release" --cql          # CQL розпізнається за умовою «поле оператор» (title = …, text ~ …);
                                                    #   --cql / --text — задати явно; свій ORDER BY у CQL зберігається

atlasmd probe                                       # версія, користувач, права, проєкти, дошки, поля, вкладення, Confluence
atlasmd docx "<шлях>.docx"                          # локальний .docx → .md поруч (напр. ТЗ з архівів вкладень)
atlasmd init                                        # підключити проєкт: .atlasmd/.env, .atlasmd/.gitignore, skill для Claude Code
atlasmd skill                                       # встановити / оновити .claude/skills/atlasmd/SKILL.md з цієї версії
atlasmd version                                     # версія інструмента (є й у першому рядку probe)
```

`atlasmd jira` чи `atlasmd wiki` без підкоманди показує команди своєї групи. `wiki page` приймає pageId,
`viewpage.action?pageId=…`, `/spaces/X/pages/<id>/…` або `/display/SPACE/Title`; результат — у stdout і в
`.atlasmd/out/wiki/<pageId>/`.

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

Знімок — `.atlasmd/out/track/state.json`, звіти — `.atlasmd/out/track/reports/<дата_час>.md`.
Динамічні вставки макросу Jira у сторінках wiki (назва/статус тікета) при порівнянні ігноруються.

### Обмеження

- Видалене **до** взяття під нагляд не відновити: Confluence сам видаляє/зливає версії сторінок
  (в історії сторінки можуть бути пропущені номери версій), Jira не зберігає видалені коментарі.
- Старий текст відредагованого коментаря Jira є лише тоді, коли коментар уже був у знімку
  (Jira зберігає тільки дату правки); з `--since` без знімка видно, що і коли змінено, і поточний текст.
- Видалення коментаря в Jira видно лише між запусками `track` (не через `--since`).
- Хто переглядав тікет/сторінку, API не віддає.
- `track` не запускається сам — його викликають у момент синку.

## Налаштування

`.atlasmd/.env` (створює `init` з [env.example](env.example)) — один із варіантів; для Jira і Confluence
можуть бути різні:

- **Server/DC:** `JIRA_BASE_URL` + `JIRA_TOKEN`, `CONFLUENCE_BASE_URL` + `CONFLUENCE_TOKEN` — окремі PAT з профілів
  Jira і Confluence, `Authorization: Bearer`. Email не задавати.
- **Cloud:** URL задаються явно, як є — `JIRA_BASE_URL=https://<site>.atlassian.net`,
  `CONFLUENCE_BASE_URL=https://<site>.atlassian.net/wiki`; `ATLASSIAN_EMAIL` + `ATLASSIAN_API_TOKEN` — один токен
  з id.atlassian.com → Security → API tokens на обидва сервіси, `Authorization: Basic`. Доступ — рівно той,
  що в цього облікового запису в браузері.
- Режим визначається так: є email (`<SERVICE>_EMAIL` / `ATLASSIAN_EMAIL`) → basic, немає → bearer;
  примусово — `JIRA_AUTH` / `CONFLUENCE_AUTH` = `bearer` | `basic`. `probe` друкує, який режим застосовано.

Змінні, вже задані в оточенні процесу, мають пріоритет над `.env` (зручно для CI).

HTTPS довіряє сертифікатам зі сховища ОС (`--use-system-ca`). `JIRA_INSECURE_TLS=1` — лише для self-hosted, якщо
ланцюжок закінчується корпоративним Root CA, якого немає і там; вимикає перевірку TLS лише для цього процесу.

<details>
<summary>Відмінності Cloud, які клієнт обробляє сам</summary>

JQL-пошук через `/rest/api/3/search/jql` (старий `/rest/api/2/search` у Cloud вимкнено; `total` не повертається —
у пошуку «N+», кількість у probe — `approximate-count`), користувачі мають `accountId` замість `name`/`username`.
Базові URL клієнт не змінює.

</details>

## Безпека

- Жодних запитів на запис у Jira чи Confluence — лише читання.
- На 401, редирект на SSO/логін або CAPTCHA клієнт зупиняється одразу, без повторів (self-hosted Jira після
  кількох 401 закриває REST за CAPTCHA).
- Токени не логуються. Якщо токен засвітився — відкликати в профілі Jira/Confluence → Personal Access Tokens
  (Server/DC) або на id.atlassian.com → Security → API tokens (Cloud; один токен відкриває обидва сервіси).

## Розробка

```
npm install                    # заодно збирає dist/ (prepare)
npm run dev -- jira issue X-1  # запуск із src/*.ts без збірки (нативне стирання типів Node)
npm run typecheck
npm run build                  # dist/ — зібраний пакет; копія сирців (цей репозиторій, .atlasmd/tool) запускає src/ напряму
```

Щоб спробувати локальні зміни в проєкті, запустіть робочу копію з кореня проєкту (вона запускає `src/` напряму,
без збірки; `.atlasmd/tool/` проєкту лишається як є):

```
node <шлях до atlasmd>/bin/atlasmd.js jira issue X-1
```

Залежності — лише конвертери в Markdown: `turndown` (+gfm для
таблиць) і `mammoth` для `.docx`.

## Релізи

Версії — git-теги `vX.Y.Z`; `version` у package.json — те, що друкують `atlasmd version` і `probe`. Теги створює CI,
вручну їх не ставити:

```
npm version minor --no-git-tag-version    # або patch / major; оновлює package.json і package-lock.json
git commit -am "Release 1.1.0" && git push
git push origin main:release              # .github/workflows/release.yml: перевірки → тег v1.1.0 + GitHub Release
```

Workflow падає, нічого не публікуючи, якщо тег уже є (версію не підняли) або перевірки не пройшли. У проєктах:
нова версія в `.atlasmd/version`, заново скачати `.atlasmd/tool/`, `skill`, коміт `.atlasmd/version` і skill. Ламаючі зміни (команди, формат `.atlasmd/.env`) — лише в новій
major-версії.

## Ліцензія

[MIT](LICENSE)
