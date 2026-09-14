// ocr-offscreen.js — распознавание текста (Tesseract rus+eng) и речи (Whisper)
// в offscreen-документе расширения. Сюда приходят сообщения из background.js.
// Файлы движков лежат в lib/ (см. lib/README-OCR.txt).

// ---------- OCR: текст с кадров (Tesseract rus+eng) ----------
let tWorkerPromise = null;

function getTWorker() {
  if (!tWorkerPromise) {
    tWorkerPromise = (async () => {
      if (typeof Tesseract === 'undefined') {
        throw new Error('Нет файла lib/tesseract.min.js — проверь наличие файлов в папке lib/.');
      }
      try {
        return await Tesseract.createWorker(['rus', 'eng'], 1, {
          workerPath: chrome.runtime.getURL('lib/worker.min.js'),
          corePath: chrome.runtime.getURL('lib/'),
          langPath: chrome.runtime.getURL('lib/'),
          workerBlobURL: false, // без blob — CSP расширения разрешает только свои скрипты
        });
      } catch (err) {
        console.warn('Не удалось загрузить rus+eng, откатываемся на rus:', err);
        return await Tesseract.createWorker('rus', 1, {
          workerPath: chrome.runtime.getURL('lib/worker.min.js'),
          corePath: chrome.runtime.getURL('lib/'),
          langPath: chrome.runtime.getURL('lib/'),
          workerBlobURL: false,
        });
      }
    })().catch((err) => {
      tWorkerPromise = null;
      throw err;
    });
  }
  return tWorkerPromise;
}

// Предобработка изображения: увеличение резкости и контрастности (grayscale + contrast stretch)
// для надёжного распознавания субтитров и надписей на динамическом фоне видео
async function preprocessForOcr(imageSource) {
  try {
    let imgBitmap = null;
    if (imageSource instanceof Blob) {
      imgBitmap = await createImageBitmap(imageSource);
    } else if (typeof imageSource === 'string' && imageSource.startsWith('data:')) {
      const resp = await fetch(imageSource);
      const b = await resp.blob();
      imgBitmap = await createImageBitmap(b);
    }

    if (!imgBitmap) return imageSource;

    const origW = imgBitmap.width;
    const origH = imgBitmap.height;
    // Оптимальный масштаб: Tesseract лучше всего читает при высоте строки ~35-50px
    const scale = Math.max(1.0, Math.min(2.0, 1600 / Math.max(origW, origH)));
    const cnv = document.createElement('canvas');
    cnv.width = Math.round(origW * scale);
    cnv.height = Math.round(origH * scale);
    const ctx = cnv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(imgBitmap, 0, 0, cnv.width, cnv.height);

    const imgData = ctx.getImageData(0, 0, cnv.width, cnv.height);
    const d = imgData.data;
    let min = 255;
    let max = 0;

    for (let i = 0; i < d.length; i += 4) {
      // Стандартная яркость Rec. 601
      const g = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
      d[i] = g;
      d[i + 1] = g;
      d[i + 2] = g;
      if (g < min) min = g;
      if (g > max) max = g;
    }

    const range = max - min;
    // Растягиваем динамический диапазон для максимальной читаемости букв
    if (range > 20 && range < 235) {
      const factor = 255 / range;
      for (let i = 0; i < d.length; i += 4) {
        const val = Math.min(255, Math.max(0, (d[i] - min) * factor));
        d[i] = val;
        d[i + 1] = val;
        d[i + 2] = val;
      }
      ctx.putImageData(imgData, 0, 0);
    }

    return cnv;
  } catch (err) {
    console.warn('OCR preprocessing fallback:', err);
    return imageSource;
  }
}

async function doOcr(imageSource) {
  const w = await getTWorker();
  const processed = await preprocessForOcr(imageSource);
  const res = await w.recognize(processed);
  return (res && res.data && res.data.text) ? res.data.text.trim() : '';
}

function compactText(s) {
  const seen = new Set();
  return String(s || '')
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => {
      if (l.length <= 1 && !/\d/.test(l)) return false;
      const key = l.toLowerCase().replace(/\s+/g, ' ');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .join('\n');
}

// Распознавание изображения по прямому URL (для слайдов карусели)
async function recognizeImageUrl(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Не удалось загрузить изображение слайда (код ${resp.status})`);
  const blob = await resp.blob();
  return await doOcr(blob);
}

// Прямое извлечение кадров из видео по URL и распознавание текста
async function extractVideoFramesAndOcr(url, headTimestamps, tailTimestamps) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Не удалось загрузить видео (код ${resp.status})`);
  const arrayBuf = await resp.arrayBuffer();
  const blob = new Blob([arrayBuf], { type: 'video/mp4' });
  const blobUrl = URL.createObjectURL(blob);

  const video = document.createElement('video');
  video.src = blobUrl;
  video.muted = true;
  video.playsInline = true;
  video.style.position = 'fixed';
  video.style.left = '-9999px';
  video.style.top = '-9999px';
  video.style.width = '640px';
  video.style.height = '360px';
  document.body.appendChild(video);

  try {
    await new Promise((resolve, reject) => {
      const onLoaded = () => { cleanup(); resolve(); };
      const onError = () => {
        cleanup();
        reject(new Error('Не удалось декодировать видео в фоновом документе.'));
      };
      const timer = setTimeout(() => { cleanup(); reject(new Error('Таймаут декодирования видео (20 с).')); }, 20000);
      function cleanup() {
        clearTimeout(timer);
        video.removeEventListener('loadeddata', onLoaded);
        video.removeEventListener('error', onError);
      }
      video.addEventListener('loadeddata', onLoaded);
      video.addEventListener('error', onError);
    });

    const w = video.videoWidth || 720;
    const h = video.videoHeight || 1280;
    const scale = Math.min(1.5, 1280 / Math.max(w, h));
    const cnv = document.createElement('canvas');
    cnv.width = Math.max(1, Math.round(w * scale));
    cnv.height = Math.max(1, Math.round(h * scale));
    const ctx = cnv.getContext('2d', { willReadFrequently: true });

    async function captureFrameAt(t) {
      return new Promise((resolve) => {
        let done = false;
        const fin = () => {
          if (done) return;
          done = true;
          video.removeEventListener('seeked', fin);
          clearTimeout(to);
          try {
            ctx.drawImage(video, 0, 0, cnv.width, cnv.height);
            resolve(cnv.toDataURL('image/jpeg', 0.92));
          } catch (e) {
            resolve(null);
          }
        };
        const to = setTimeout(fin, 1200);
        video.addEventListener('seeked', fin, { once: true });
        try {
          video.currentTime = Math.min(Math.max(0.01, (video.duration || 10) - 0.05), Math.max(0.01, t));
        } catch (_) {
          fin();
        }
      });
    }

    const headFrames = [];
    for (const t of headTimestamps) {
      const f = await captureFrameAt(t);
      if (f) headFrames.push(f);
    }

    const tailFrames = [];
    for (const t of tailTimestamps) {
      const f = await captureFrameAt(t);
      if (f) tailFrames.push(f);
    }

    const headTexts = [];
    for (const frame of headFrames) {
      try {
        const txt = await doOcr(frame);
        if (txt) headTexts.push(txt);
      } catch (e) {
        console.warn('Ошибка OCR кадра начала:', e);
      }
    }

    const tailTexts = [];
    for (const frame of tailFrames) {
      try {
        const txt = await doOcr(frame);
        if (txt) tailTexts.push(txt);
      } catch (e) {
        console.warn('Ошибка OCR кадра конца:', e);
      }
    }

    return {
      headText: compactText(headTexts.join('\n')),
      tailText: compactText(tailTexts.join('\n')),
    };
  } finally {
    try {
      video.pause();
      video.src = '';
      video.remove();
    } catch (_) {}
    URL.revokeObjectURL(blobUrl);
  }
}

// ---------- ASR: речь из звука (Whisper) ----------
let asrPipe = null;

async function getAsrPipe() {
  if (asrPipe) return asrPipe;
  let transformers;
  try {
    transformers = await import(chrome.runtime.getURL('lib/transformers.min.js'));
  } catch (e) {
    throw new Error('Не удалось загрузить lib/transformers.min.js: ' + ((e && e.message) || e));
  }

  const env = transformers.env;
  env.allowLocalModels = false;
  env.allowRemoteModels = true;
  env.useBrowserCache = true;

  if (env.backends && env.backends.onnx && env.backends.onnx.wasm) {
    env.backends.onnx.wasm.proxy = false;
    env.backends.onnx.wasm.numThreads = 1;
    env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('lib/');
  }

  const pipeline = transformers.pipeline;
  let firstErr = null;

  try {
    env.remoteHost = 'https://huggingface.co/';
    asrPipe = await pipeline('automatic-speech-recognition', 'onnx-community/whisper-tiny', {
      quantized: true,
    });
    return asrPipe;
  } catch (e1) {
    firstErr = e1;
    console.warn('Загрузка onnx-community/whisper-tiny с huggingface.co не удалась, пробуем Xenova/whisper-tiny:', e1);
  }

  try {
    env.remoteHost = 'https://huggingface.co/';
    asrPipe = await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny', {
      quantized: true,
    });
    return asrPipe;
  } catch (e2) {
    console.warn('Загрузка Xenova/whisper-tiny с huggingface.co не удалась, пробуем через hf-mirror.com:', e2);
  }

  try {
    env.remoteHost = 'https://hf-mirror.com/';
    asrPipe = await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny', {
      quantized: true,
    });
    return asrPipe;
  } catch (e3) {
    console.warn('Загрузка с hf-mirror.com не удалась:', e3);
    throw new Error(
      'Ошибка загрузки модели Whisper (проверь интернет или VPN): ' +
        ((firstErr && firstErr.message) || firstErr)
    );
  }
}

// Очистка текста от галлюцинаций Whisper и повторяющихся слов/фраз при паузах или фоновой музыке
function cleanWhisperText(text) {
  if (!text) return '';
  let str = String(text).trim();

  // Удаление стандартных титров и артефактов тишины
  str = str.replace(/субтитры\s+(?:делал|сделал|создал|подготовил|перевёл)[^\n\.\,]*/gi, '');
  str = str.replace(/спасибо\s+за\s+просмотр[^\n\.\,]*/gi, '');
  str = str.replace(/продолжение\s+следует[^\n\.\,]*/gi, '');
  str = str.replace(/редактор\s+субтитров[^\n\.\,]*/gi, '');

  // Токенизация и схлопывание повторяющихся слов (например, "было было было было" -> "было")
  const tokens = str.split(/(\s+)/);
  const out = [];
  let lastWord = '';
  let repeatCount = 0;

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (/^\s+$/.test(t)) {
      if (repeatCount === 0) out.push(t);
      continue;
    }
    const cleanWord = t.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    if (cleanWord && cleanWord === lastWord) {
      repeatCount++;
      continue;
    } else {
      lastWord = cleanWord;
      repeatCount = 0;
    }
    out.push(t);
  }

  let res = out.join('').trim();
  // Схлопывание 2-4 словных повторяющихся фраз
  res = res.replace(/(([^\s]+(?:\s+[^\s]+){1,3}))(?:\s+\1){2,}/gi, '$1');
  return res.trim();
}

// Пересэмплирование аудиофрагмента в 16 кГц, пик-нормализация громкости и распознавание Whisper
async function transcribeSegment(audioBuffer, startSec, endSec) {
  const start = Math.max(0, startSec);
  const end = Math.min(audioBuffer.duration, endSec);
  if (end <= start) return '';
  const dur = end - start;
  const targetLen = Math.max(1, Math.ceil(dur * 16000));
  const off = new OfflineAudioContext(1, targetLen, 16000);
  const src = off.createBufferSource();
  src.buffer = audioBuffer;
  src.connect(off.destination);
  src.start(0, start, dur);
  const rendered = await off.startRendering();
  const pcm = rendered.getChannelData(0);

  // Peak-нормализация: вытягиваем тихий звук до максимальной амплитуды 0.95
  let maxAmp = 0;
  for (let i = 0; i < pcm.length; i++) {
    const v = Math.abs(pcm[i]);
    if (v > maxAmp) maxAmp = v;
  }
  // Если звук практически отсутствует (тишина или фоновый шум)
  if (maxAmp < 0.005) {
    return '';
  }
  const gain = 0.95 / maxAmp;
  for (let i = 0; i < pcm.length; i++) {
    pcm[i] *= gain;
  }

  const pipe = await getAsrPipe();
  const res = await pipe(pcm, {
    language: 'russian',
    task: 'transcribe',
    return_timestamps: false,
    chunk_length_s: 30,
    stride_length_s: 5,
    max_new_tokens: 128,
    repetition_penalty: 1.35,
    no_repeat_ngram_size: 3,
  });

  let raw = '';
  if (Array.isArray(res)) raw = res.map((r) => (r && r.text) || '').join(' ').trim();
  else raw = ((res && res.text) || '').trim();

  return cleanWhisperText(raw);
}

async function recognizeAudioBase64(base64) {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

  const AC = window.AudioContext || window.webkitAudioContext;
  const ac = new AC();
  const decoded = await ac.decodeAudioData(bytes.buffer.slice(0));
  return transcribeSegment(decoded, 0, decoded.duration);
}

async function recognizeAudioFromUrl(url, headTo, tailFrom, tailTo) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Не удалось скачать видео (код ${resp.status}).`);
  const buf = await resp.arrayBuffer();
  const AC = window.AudioContext || window.webkitAudioContext;
  const ac = new AC();
  let decoded;
  try {
    decoded = await ac.decodeAudioData(buf);
  } catch (e) {
    throw new Error('Unable to decode audio data: видео-контейнер не поддерживается напрямую Web Audio API.');
  }
  if (!decoded || decoded.duration <= 0) throw new Error('В этом видео нет аудиодорожки.');

  const headText = await transcribeSegment(decoded, 0, headTo);
  const tailText = await transcribeSegment(decoded, tailFrom, Math.min(decoded.duration, tailTo));
  return { headText, tailText };
}

// ---------- Приём сообщений ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return false;

  if (msg.type === 'ocrPing') {
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'ocrDo') {
    (async () => {
      try {
        const text = await doOcr(msg.image);
        sendResponse({ ok: true, text });
      } catch (e) {
        tWorkerPromise = null;
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true;
  }

  if (msg.type === 'ocrImageUrl') {
    (async () => {
      try {
        const text = await recognizeImageUrl(msg.url);
        sendResponse({ ok: true, text });
      } catch (e) {
        tWorkerPromise = null;
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true;
  }

  if (msg.type === 'ocrVideoDo') {
    (async () => {
      try {
        const res = await extractVideoFramesAndOcr(msg.url, msg.headTimestamps || [], msg.tailTimestamps || []);
        sendResponse({ ok: true, headText: res.headText, tailText: res.tailText });
      } catch (e) {
        tWorkerPromise = null;
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true;
  }

  if (msg.type === 'asrDo') {
    (async () => {
      try {
        const text = await recognizeAudioBase64(msg.audio);
        sendResponse({ ok: true, text });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true;
  }

  if (msg.type === 'asrDoUrl') {
    (async () => {
      try {
        const res = await recognizeAudioFromUrl(msg.url, msg.headTo, msg.tailFrom, msg.tailTo);
        sendResponse({ ok: true, headText: res.headText, tailText: res.tailText });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true;
  }

  return false;
});
