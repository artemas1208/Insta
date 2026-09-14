// ocr-offscreen.js — распознавание текста (Tesseract) и речи (Whisper/transformers.js)
// в offscreen-документе расширения. Сюда приходят сообщения из background.js.
// Файлы движков лежат в lib/ (см. lib/README-OCR.txt).

// ---------- OCR: текст с кадров (Tesseract) ----------
let tWorkerPromise = null;

function getTWorker() {
  if (!tWorkerPromise) {
    tWorkerPromise = (async () => {
      if (typeof Tesseract === 'undefined') {
        throw new Error('Нет файла lib/tesseract.min.js — проверь наличие файлов в папке lib/.');
      }
      return Tesseract.createWorker('rus', 1, {
        workerPath: chrome.runtime.getURL('lib/worker.min.js'),
        corePath: chrome.runtime.getURL('lib/'),
        langPath: chrome.runtime.getURL('lib/'),
        workerBlobURL: false, // без blob — CSP расширения разрешает только свои скрипты
      });
    })();
  }
  return tWorkerPromise;
}

// ---------- ASR: речь из звука (whisper-tiny, русский) ----------
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
  if (env.backends && env.backends.onnx && env.backends.onnx.wasm) {
    env.backends.onnx.wasm.proxy = false;
    env.backends.onnx.wasm.numThreads = 1;
    env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('lib/');
  }

  asrPipe = await transformers.pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny', {
    dtype: 'q8',
  });
  return asrPipe;
}

// Пересэмплирование аудиофрагмента в 16 кГц и распознавание через Whisper
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

  const pipe = await getAsrPipe();
  const res = await pipe(pcm, { language: 'russian', task: 'transcribe' });
  if (Array.isArray(res)) return res.map((r) => (r && r.text) || '').join(' ').trim();
  return ((res && res.text) || '').trim();
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
  const decoded = await ac.decodeAudioData(buf);

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
        const w = await getTWorker();
        const { data } = await w.recognize(msg.image);
        sendResponse({ text: (data && data.text) || '' });
      } catch (e) {
        tWorkerPromise = null; // сбрасываем, чтобы следующий запрос поднял воркер заново
        sendResponse({ error: String((e && e.message) || e) });
      }
    })();
    return true;
  }

  if (msg.type === 'asrDo') {
    (async () => {
      try {
        sendResponse({ text: await recognizeAudioBase64(msg.audio) });
      } catch (e) {
        sendResponse({ error: String((e && e.message) || e) });
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
        sendResponse({ error: String((e && e.message) || e) });
      }
    })();
    return true;
  }

  return false;
});
