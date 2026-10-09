# Локальные медиаассеты

Репозиторий содержит исходный код и карты движений, но не распространяет обработанные ролики или музыку третьих лиц.

Для двух текущих карт положите локальные прозрачные VP9 WebM сюда:

```text
extension/assets/cats/three-cats/video.webm
extension/assets/cats/white-cat/video.webm
```

Файл исключён через `.gitignore`. Его можно подготовить из материала, на который у пользователя есть необходимые права:

```bash
tools/assets/process-reference-cats.sh input.mp4 \
  extension/assets/cats/three-cats/video.webm
```

Для ролика без однотонного фона можно использовать локально установленный `rembg`:

```bash
REMBG_COMMAND=/path/to/rembg tools/assets/process-rembg-video.sh \
  input.mp4 extension/assets/cats/white-cat/video.webm u2net
```

Backend временно хранит скачанное аудио только на время анализа. В `backend/data` остаются общая музыкальная карта и небольшие JSON-карты хореографии; этот каталог также исключён из Git.
