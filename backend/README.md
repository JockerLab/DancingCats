# Dancing Cats local backend

Локальный HTTP-сервис получает публичный YouTube URL, временно извлекает аудио, определяет ритм через `Beat This! small0`, строит приближённую структуру композиции и сохраняет отдельные choreography maps для запрошенных ассетов. Исходное аудио удаляется после каждого задания.

Сервис слушает только `127.0.0.1:8765`. Максимальная длительность по умолчанию — 15 минут.

## Запуск через Docker

Нужен Docker с установленным плагином Buildx. Один раз создайте BuildKit builder:

```bash
docker buildx create \
  --name dancing-cats-builder \
  --driver docker-container \
  --use
docker buildx inspect --bootstrap
```

Если builder уже существует, достаточно выполнить:

```bash
docker buildx use dancing-cats-builder
```

Из корня проекта соберите образ через BuildKit и загрузите его в локальное хранилище Docker:

```bash
docker buildx build \
  --builder dancing-cats-builder \
  --load \
  --tag dancing-cats-backend:local \
  backend
```

Запуск контейнера в фоне (имя контейнера сохраняет логи, если анализ завершится с ошибкой):

```bash
docker run --detach --name dancing-cats-backend \
  -p 127.0.0.1:8765:8765 \
  -v "$PWD/backend/data:/app/data" \
  -v "$PWD/backend/models:/models" \
  -v "$PWD/extension/assets:/assets:ro" \
  dancing-cats-backend:local
```

Убедитесь, что сервис запущен, затем оставьте логи открытыми во время первого анализа:

```bash
curl http://127.0.0.1:8765/health
docker logs --follow dancing-cats-backend
```

После запуска расширения значок `…` означает обработку трека или загрузку ассета, `ON` — готовую карту, а `!` — ошибку. Browser fallback отсутствует.

`--load` необходим для одноплатформенной локальной сборки: без него результат остаётся только в кеше BuildKit. Для публикации multi-platform образа вместо `--load` используется `--push` и адрес registry.

По умолчанию образ использует CPU-only PyTorch. Это исключает многогигабайтные CUDA-библиотеки NVIDIA из сборки. Для компьютера с настроенным NVIDIA Container Toolkit можно явно выбрать поддерживаемый PyTorch wheel channel, например:

```bash
docker buildx build \
  --builder dancing-cats-builder \
  --build-arg PYTORCH_WHEEL_CHANNEL=cu128 \
  --load \
  --tag dancing-cats-backend:cuda \
  backend
```

Актуальный CUDA channel следует выбирать по официальному конфигуратору PyTorch. GPU-образ закономерно будет существенно больше CPU-варианта.

Основные Python-зависимости анализа зафиксированы на совместимых версиях, чтобы `pip`
не перебирал десятки вариантов FastAPI/Pydantic при каждой сборке. Для нестабильного
соединения установлены десять повторов и timeout 120 секунд. `yt-dlp` намеренно не
зафиксирован: его приходится регулярно обновлять вслед за изменениями YouTube.

### Permission denied для Docker socket

Если команда сообщает `permission denied ... /var/run/docker.sock`, сначала выполните `docker info` в обычном терминале хостовой ОС. В managed/dev-контейнере Docker socket должен быть явно проброшен с корректным GID; сокет `nobody:nobody` и read-only `/run` нельзя исправить изнутри такого контейнера — запускайте `buildx` на хосте или пересоздайте контейнер с доступом к Docker daemon.

На обычном rootful Linux пользователь должен входить в группу `docker`; после добавления требуется новый login-сеанс:

```bash
sudo usermod -aG docker "$(id -un)"
newgrp docker
docker info
```

Группа `docker` фактически предоставляет root-доступ к машине. Не используйте `sudo chmod 666 /var/run/docker.sock`.

При первом запуске Beat This! скачивает checkpoint `small0` размером около 8 МБ из хранилища авторов. Он не входит в Docker image. Каталог `backend/models` подключён к `/models`, поэтому повторный запуск контейнера не загружает веса заново.

Backend начинает warm-up rhythm-модели сразу после старта и переиспользует её для следующих заданий. Warm-up выполняется отдельно, поэтому скачивание YouTube audio может идти параллельно загрузке модели. Demucs и All-In-One больше не используются.

Логи содержат отдельные времена download/FFmpeg, rhythm inference, структурного анализа и planners. Одновременно выполняется только один ML-job, чтобы анализы не конкурировали за CPU и RAM. Результат музыкального анализа кешируется отдельно; planners всех ассетов используют его параллельно без повторной загрузки и inference.

## Локальная установка

Backend использует `Beat This!` без DBN-постобработки и `librosa`. Для воспроизводимости рекомендуется Python 3.10–3.11.

```bash
cd backend
python3.11 -m venv .venv
. .venv/bin/activate
pip install -e ".[analysis,dev]"
dancing-cats-backend
```

Также необходимы `ffmpeg`, `ffprobe` и поддерживаемый `yt-dlp` JavaScript runtime, например Node.js.

## API

```bash
curl http://127.0.0.1:8765/health
```

```bash
curl -X POST http://127.0.0.1:8765/v1/analysis \
  -H 'Content-Type: application/json' \
  -d '{"youtubeUrl":"https://www.youtube.com/watch?v=VIDEO_ID","assetIds":["three-cats","white-cat"]}'
```

Ответ содержит `jobId`, общий `status` и подробный `stage`: `queued`, `downloading`, `analyzing`, `planning`, `cached`, `complete` или `error`. Состояние проверяется через `GET /v1/analysis/{jobId}`. После завершения `mapUrls` сопоставляет каждый `assetId` с готовой картой; для одиночного legacy-запроса также возвращается `mapUrl`. Переходы `status/stage` записываются в Docker-лог.

Swagger UI доступен на `http://127.0.0.1:8765/docs`.

## Переменные окружения

- `DANCING_CATS_HOST` — по умолчанию `127.0.0.1`;
- `DANCING_CATS_PORT` — по умолчанию `8765`;
- `DANCING_CATS_DATA_DIR` — каталог JSON-кеша;
- `DANCING_CATS_ASSETS_DIR` — каталог с `catalog.json` и motion maps;
- `DANCING_CATS_MAX_DURATION` — лимит видео в секундах, по умолчанию 900.
- `DANCING_CATS_RHYTHM_MODEL` — checkpoint Beat This!, по умолчанию `small0`.

Не выставляйте сервис в публичную сеть. Он предназначен только для персональной локальной работы и принимает только HTTPS URL `youtube.com`/`youtu.be` без cookies и плейлистов.
