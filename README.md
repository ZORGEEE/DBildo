# DBildo

Desktop IDE для дата-инженера: PostgreSQL, ClickHouse, Airflow и официальный
DeepSeek Harness. Это первая работающая версия проекта. [Архитектура](ARCHITECTURE.md)
и [спецификация](SPEC.md) описывают дальнейшее развитие.

## Быстрый запуск

Требуются Node.js 24+, npm и Docker Desktop (для локальных баз и Airflow).

```bash
npm install
cp .env.example .env
npm run infra:up
npm run dev:desktop
```

`infra:up` копирует пример DAG из `workspace/dags/` в `runtime/airflow/dags/`,
затем поднимает PostgreSQL, ClickHouse и Airflow 3. После запуска нажмите
«Обновить» в IDE. В PostgreSQL будет таблица `public.orders`, в ClickHouse —
`default.orders`; DAG `orders_to_clickhouse` появится после разбора Airflow.

Для агента впишите свой `DEEPSEEK_API_KEY` в `.env` перед запуском backend.
Ключ остаётся на локальной машине и не передаётся UI. Настройка собственного
DeepSeek-совместимого endpoint пока не реализована.

Если нужен веб-интерфейс без окна Electron:

```bash
npm run dev
```

Откройте `http://127.0.0.1:5173`. После `npm run build` можно использовать
`npm run start:server` и открыть `http://127.0.0.1:4317`.
`npm run start:desktop` запускает собранный UI из текущего checkout.

Стенд останавливается командой `npm run infra:down`; volumes сохраняются.
В приложении можно работать с файлами и видеть интерфейс без Docker.

## Что уже работает

- Desktop-окно и тот же UI в браузере через локальный backend.
- Проверка подключений, каталоги PostgreSQL/ClickHouse и описание колонок.
- Редактор SQL с запросами чтения, ограниченным результатом, таблицей и простым графиком.
- Просмотр DAG Airflow 3, запусков, графа задач, логов и состояния выбранного запуска;
  запуск DAG через IDE.
- Граф lineage для демонстрационного пайплайна, заданный в `workspace/lineage.json`.
- Редактор Python/SQL файлов с проверкой изменений перед сохранением.
- Отдельная публикация сохранённого DAG как снимка для dev Airflow.
- Сессия официального Harness SDK и команды агента для исследования баз, DAG и логов.

## Границы первой версии

Docker-движок нужен для проверки реальных запросов и запусков DAG. Без API ключа
агентная панель показывает настройку, но не выполняет ход. SDK Harness находится
в developer preview; его версия закреплена вместе с runtime.

SQL в IDE выполняется только на чтение. PostgreSQL-запрос идёт в read-only
транзакции с timeout; ClickHouse-запрос отправляется через HTTP GET и ограничен
по времени выполнения. Запросы ограничены
200 строками в UI и 100 строками в инструменте агента. Для production источников
создайте отдельные роли БД с необходимыми правами.

Публикация копирует файл в каталог dev, но не подтверждает, что Airflow разобрал
его и начал выполнять новую версию. Автоматический lineage между системами и установка упакованного `.app` — следующие
этапы. Сейчас desktop запускается из исходного проекта.

## Разработка

```bash
npm run build
npm run check:harness
docker compose -f infra/dev/compose.yaml config --quiet
```

`runtime/`, `.env` и `node_modules/` исключены из Git. Контейнерные пароли в
Compose предназначены только для локального dev-стенда, порты привязаны к loopback.
