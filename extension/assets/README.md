# Каталог танцевальных ассетов

Каждый набор хранится изолированно:

```text
assets/
├── catalog.json
└── cats/
    └── <asset-id>/
        ├── video.webm
        └── motion-map.json
```

Один asset может визуально содержать несколько котов, но `entityMode: "single-group"` означает, что они всегда воспроизводятся, перемещаются и масштабируются как один неделимый видеообъект.

Поле каталога `videoIncluded: false` означает, что WebM не распространяется в публичном репозитории и устанавливается локально.

## Motion map v2

Верхний уровень:

- `schemaVersion: 2`;
- `id` совпадает с catalog ID;
- `entityMode: "single-group"`;
- `video` — WebM относительно карты;
- `duration` — точная длительность;
- `nativeBpm` — естественный темп;
- `phraseBeats` — суммарная длина segments;
- `segments` — покрытие используемых диапазонов исходного WebM;
- `excludedRanges` — необязательные интервалы с дефектными кадрами, которые
  намеренно пропускаются (для каждого интервала обязательно указывается причина).

Каждый segment содержит:

- `sourceStart`, `sourceEnd`, `beats`;
- `energy`, `intensity`, `fluidity` в диапазоне `0..1`;
- `tempoRange: [minBpm, maxBpm]`;
- `sectionAffinity` — подходящие функциональные labels облегчённого анализатора;
- `tags` — смысловые признаки движения;
- `entryPose`, `exitPose`;
- `hardCutSafe` — разрешён ли произвольный резкий вход;
- `loopable` — разрешён ли немедленный повтор;
- `maxConsecutive` — максимальное число повторов подряд;
- `next` — предпочтительные резкие переходы.

`hardCutSafe: false` не запрещает segment полностью: он остаётся доступен после движений, которые явно перечисляют его в `next`.

## Добавление набора

1. Создайте `assets/cats/<asset-id>`.
2. Добавьте прозрачный VP9 WebM без аудио.
3. Разметьте законченные движения и безопасные hard cuts.
4. Для loopable segment вручную проверьте переход `sourceEnd → sourceStart`.
5. Добавьте catalog entry.
6. Выполните `python3 tools/validate_extension.py`.
