# Видеоассеты

Готовые прозрачные VP9 WebM входят в репозиторий вместе с картами движений.
Расширение не поддерживает «частично установленный» каталог: у каждой записи
`extension/assets/catalog.json` обязаны существовать и `motion-map.json`, и
`video.webm`.

## Структура

```text
extension/assets/
├── catalog.json
└── cats/
    ├── one-cat-1/
    │   ├── motion-map.json
    │   └── video.webm
    ├── two-cats-1/
    ├── two-cats-2/
    ├── three-cats-1/
    └── three-cats-2/
```

Каждая папка описывает один неделимый слой, независимо от числа котов внутри
ролика. Поэтому в motion map нет `entityMode`, а в каталоге нет
`videoIncluded`: оба условия являются обязательной частью формата.

Текущие исходные референсы:

| ID | Референс |
| --- | --- |
| `one-cat-1` | <https://www.youtube.com/shorts/fVuK4D7zQYc> |
| `two-cats-1` | <https://www.youtube.com/shorts/ZdNn1JBNrRU> |
| `two-cats-2` | <https://www.youtube.com/shorts/lfVhos3qyik> |
| `three-cats-1` | <https://www.youtube.com/shorts/_VvPjfjOpxE> |
| `three-cats-2` | <https://www.youtube.com/shorts/N741OAlSZfY> |

Перед публичным распространением репозитория необходимо убедиться, что права и
условия лицензий исходных роликов разрешают публикацию производных WebM.

## Инструменты

Инструменты не участвуют в runtime расширения или backend:

- `tools/validate_extension.py` проверяет каталог, карты, наличие WebM, VP9,
  alpha channel, длительность и связи между движениями. Его следует запускать
  перед коммитом.
- `tools/assets/process-cats.sh` — необязательный общий authoring-пайплайн для
  новых роликов с однотонным зелёным фоном. Он обрезает исходник, удаляет фон,
  уменьшает изображение, кодирует VP9 и вызывает reverse-банк.
- `tools/assets/add-reverse-bank.sh` — внутренний helper предыдущего скрипта. Он
  добавляет после прямой половины те же кадры в обратном порядке для ping-pong.

Специализированный обработчик первого референса и экспериментальный rembg-пайплайн
удалены: текущим приложением они не вызывались, а первый полностью дублировал
общий chroma-key скрипт.

Пример подготовки нового ассета:

```bash
tools/assets/process-cats.sh input.mp4 \
  extension/assets/cats/new-asset/video.webm \
  0 "" 0x00FF00 0.14 0.055 960:1080:60:400 480
```

Аргументы после output: начало, длительность, цвет фона, similarity, blend,
crop (`width:height:x:y`) и итоговая ширина. Параметры подбираются для каждого
исходника визуально.

После добавления или замены ассета:

```bash
python3 tools/validate_extension.py
```

Backend временно хранит скачанное аудио только во время анализа. Общая
музыкальная карта и карты хореографии находятся в `backend/data`, который не
входит в репозиторий.
