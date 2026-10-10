# Локальные медиаассеты

Репозиторий содержит исходный код и карты движений, но не распространяет обработанные ролики или музыку третьих лиц.

Для пяти текущих карт положите локальные прозрачные VP9 WebM сюда:

```text
extension/assets/cats/three-cats/video.webm
extension/assets/cats/solo-dancing-cat/video.webm
extension/assets/cats/kitten-trio/video.webm
extension/assets/cats/dancing-cat-duo/video.webm
extension/assets/cats/mushroom-kitten-duo/video.webm
```

Файлы исключены через `.gitignore`. Их можно подготовить из материалов, на которые у пользователя есть необходимые права:

```bash
tools/assets/process-reference-cats.sh input.mp4 \
  extension/assets/cats/three-cats/video.webm
```

Новые референсы имеют зелёный фон. Точные команды chroma-key, crop и scale
записаны в README соответствующего ассета. Для других роликов без однотонного
фона можно использовать локально установленный `rembg`:

```bash
REMBG_COMMAND=/path/to/rembg tools/assets/process-rembg-video.sh \
  input.mp4 extension/assets/cats/my-cat/video.webm u2net
```

Backend временно хранит скачанное аудио только на время анализа. В `backend/data` остаются общая музыкальная карта и небольшие JSON-карты хореографии; этот каталог также исключён из Git.
