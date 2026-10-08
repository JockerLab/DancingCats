# Third-party notices

Этот проект интегрируется со следующими компонентами, которые устанавливаются пользователем и сохраняют собственные лицензии:

- Beat This! code and published model weights — MIT;
- librosa — ISC;
- NumPy — BSD-3-Clause;
- SciPy — BSD-3-Clause;
- scikit-learn — BSD-3-Clause;
- yt-dlp — Unlicense с отдельно лицензируемыми необязательными компонентами;
- FFmpeg — LGPL/GPL в зависимости от сборки;
- FastAPI — MIT;
- Uvicorn — BSD-3-Clause;
- PyTorch и транзитивные ML-зависимости — согласно их собственным лицензиям.

Репозиторий не содержит веса моделей, FFmpeg/yt-dlp binaries, аудиофайлы YouTube или обработанное видео с котами. Checkpoint Beat This! загружается при первом старте в локальный model cache. Перед распространением сборки необходимо повторно проверить состав и лицензии фактически включённых зависимостей.
