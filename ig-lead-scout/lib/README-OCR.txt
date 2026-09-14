Файлы для распознавания текста (OCR) и речи (Whisper ASR) с видео:

1. Текст с экрана (OCR / Tesseract):
   - tesseract.min.js                 — библиотека Tesseract.js
   - worker.min.js                    — воркер Tesseract.js (версия 5.1.1)
   - tesseract-core-simd-lstm.wasm.js — движок распознавания (WASM)
   - rus.traineddata.gz               — словарь русского языка (~8 МБ)

2. Речь из звука (ASR / Whisper):
   - transformers.min.js              — библиотека Transformers.js
   - ort-wasm-simd.wasm               — рантайм ONNX WebAssembly

Все эти файлы уже скачаны и находятся в папке lib/.
При первом запуске «Речь из звука» модель Xenova/whisper-tiny (~40 МБ) автоматически загружается
и кешируется в браузере (в последующие разы загрузка мгновенная).

После внесения изменений:
1. Открой chrome://extensions в браузере.
2. Нажми значок 🔄 «Обновить» у расширения IG Lead Scout.
3. Обнови страницу Инстаграма (F5).
