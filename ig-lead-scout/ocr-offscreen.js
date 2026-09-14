// ocr-offscreen.js
// Фоновое распознавание текста (Tesseract rus+eng) и речи (Whisper / Cloud API)
// в offscreen-документе расширения.

const RUSSIAN_ASR_PROMPT = 'Русская речь, фитнес, тренировки, упражнения, ягодицы, кроссовер, присед, зал, блогеры, Reels, Instagram.';

// ---------- OCR: текст с кадров (Tesseract rus+eng) ----------
let tWorkerPromise = null;

async function getTWorker() {
  if (!tWorkerPromise) {
    tWorkerPromise = (async () => {
      if (typeof Tesseract === 'undefined') {
        throw new Error('Нет файла lib/tesseract.min.js — проверь наличие файлов в папке lib/.');
      }
      let worker;
      try {
        worker = await Tesseract.createWorker(['rus', 'eng'], 1, {
          workerPath: chrome.runtime.getURL('lib/worker.min.js'),
          corePath: chrome.runtime.getURL('lib/'),
          langPath: chrome.runtime.getURL('lib/'),
          workerBlobURL: false,
        });
      } catch (err) {
        console.warn('Не удалось загрузить rus+eng, откатываемся на rus:', err);
        worker = await Tesseract.createWorker('rus', 1, {
          workerPath: chrome.runtime.getURL('lib/worker.min.js'),
          corePath: chrome.runtime.getURL('lib/'),
          langPath: chrome.runtime.getURL('lib/'),
          workerBlobURL: false,
        });
      }
      // PSM 11 (SPARSE_TEXT): находит весь текст любой величины (заголовки, мелкий текст, плавающий текст)
      await worker.setParameters({
        tessedit_pageseg_mode: '11',
        preserve_interword_spaces: '1',
      });
      return worker;
    })().catch((err) => {
      tWorkerPromise = null;
      throw err;
    });
  }
  return tWorkerPromise;
}

// Предобработка изображения: увеличение контрастности без размытия деталей
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

    const w = imgBitmap.width;
    const h = imgBitmap.height;
    const cnv = document.createElement('canvas');
    cnv.width = w;
    cnv.height = h;
    const ctx = cnv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(imgBitmap, 0, 0, w, h);

    const imgData = ctx.getImageData(0, 0, w, h);
    const d = imgData.data;

    for (let i = 0; i < d.length; i += 4) {
      const gray = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
      const c = gray > 140 ? Math.min(255, gray + 25) : Math.max(0, gray - 25);
      d[i] = c;
      d[i + 1] = c;
      d[i + 2] = c;
    }
    ctx.putImageData(imgData, 0, 0);
    return cnv;
  } catch (err) {
    console.warn('OCR preprocessing fallback:', err);
    return imageSource;
  }
}

async function doOcr(imageSource) {
  const w = await getTWorker();

  // 1-й проход: по чистому полноцветному изображению с PSM 11 (Leptonica сама делает адаптивную бинаризацию)
  let res = await w.recognize(imageSource);
  let text = (res && res.data && res.data.text) ? res.data.text.trim() : '';

  // Если текста мало или он пустой, 2-й проход: с повышенной контрастностью
  if (!text || text.length < 10) {
    try {
      const processed = await preprocessForOcr(imageSource);
      if (processed && processed !== imageSource) {
        const res2 = await w.recognize(processed);
        const text2 = (res2 && res2.data && res2.data.text) ? res2.data.text.trim() : '';
        if (text2 && text2.length > text.length) {
          text = text2;
        }
      }
    } catch (_) {}
  }

  // 3-й проход: PSM 6 (единый блок текста)
  if (!text || text.length < 5) {
    try {
      await w.setParameters({ tessedit_pageseg_mode: '6' });
      const res6 = await w.recognize(imageSource);
      await w.setParameters({ tessedit_pageseg_mode: '11' });
      const text6 = (res6 && res6.data && res6.data.text) ? res6.data.text.trim() : '';
      if (text6 && text6.length > text.length) {
        text = text6;
      }
    } catch (_) {
      try { await w.setParameters({ tessedit_pageseg_mode: '11' }); } catch (_) {}
    }
  }

  return text;
}

function compactText(s) {
  const seen = new Set();
  const input = Array.isArray(s) ? s.join('\n') : String(s || '');
  return input
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => {
      // Сохраняем одиночные буквы и цифры ("и", "в", "а", "1"), отсекаем только одиночный мусор типа "|", "-"
      if (l.length <= 1 && !/[\p{L}\p{N}]/u.test(l)) return false;
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

// ---------- ASR: речь из звука (Cloud API / Whisper Local) ----------
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

// Преобразование AudioBuffer в WAV Blob для отправки в Cloud API
function audioBufferToWav(buffer) {
  const numChannels = 1;
  const sampleRate = buffer.sampleRate;
  const channelData = buffer.getChannelData(0);
  const dataLen = channelData.length * 2;
  const bufferLen = 44 + dataLen;
  const out = new ArrayBuffer(bufferLen);
  const view = new DataView(out);

  function writeString(offset, string) {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  }

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataLen, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * 2, true);
  view.setUint16(32, numChannels * 2, true);
  view.setUint16(34, 16, true); // 16 bit
  writeString(36, 'data');
  view.setUint32(40, dataLen, true);

  let offset = 44;
  for (let i = 0; i < channelData.length; i++) {
    const s = Math.max(-1, Math.min(1, channelData[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }
  return new Blob([out], { type: 'audio/wav' });
}

// Транскрибация через бесплатный Groq API (Whisper Large v3) или OpenAI API
async function transcribeViaCloudApi(audioBlobOrBytes, apiKey, prompt) {
  const cleanKey = (apiKey || '').trim();
  const isGroq = cleanKey.startsWith('gsk_');
  const endpoint = isGroq
    ? 'https://api.groq.com/openai/v1/audio/transcriptions'
    : 'https://api.openai.com/v1/audio/transcriptions';
  const model = isGroq ? 'whisper-large-v3' : 'whisper-1';

  const blob = audioBlobOrBytes instanceof Blob
    ? audioBlobOrBytes
    : new Blob([audioBlobOrBytes], { type: 'audio/webm' });

  const fd = new FormData();
  fd.append('file', blob, 'audio.webm');
  fd.append('model', model);
  fd.append('language', 'ru');
  fd.append('temperature', '0');
  if (prompt) fd.append('prompt', prompt);

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cleanKey}`,
    },
    body: fd,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Ошибка ${isGroq ? 'Groq' : 'OpenAI'} API (${res.status}): ${errText}`);
  }

  const json = await res.json();
  return (json.text || '').trim();
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
  res = res.replace(/((?:[^\s]+\s+){1,4})\1{2,}/gi, '$1');
  return res.trim();
}

// Пересэмплирование аудиофрагмента в 16 кГц, пик-нормализация громкости и распознавание Whisper
async function transcribeSegment(audioBuffer, startSec, endSec, apiKey) {
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

  // Peak-нормализация: вытягиваем звук до максимальной амплитуды 0.95
  let maxAmp = 0;
  for (let i = 0; i < pcm.length; i++) {
    const v = Math.abs(pcm[i]);
    if (v > maxAmp) maxAmp = v;
  }
  if (maxAmp < 0.005) {
    return '';
  }
  const gain = 0.95 / maxAmp;
  for (let i = 0; i < pcm.length; i++) {
    pcm[i] *= gain;
  }

  // Если передан API ключ (Groq / OpenAI) — отправляем напрямую в Cloud API (мгновенно и без ошибок)
  const cleanKey = (apiKey || '').trim();
  if (cleanKey.startsWith('gsk_') || cleanKey.startsWith('sk-')) {
    try {
      const wavBlob = audioBufferToWav(rendered);
      return await transcribeViaCloudApi(wavBlob, cleanKey, RUSSIAN_ASR_PROMPT);
    } catch (e) {
      console.warn('Ошибка Cloud API в transcribeSegment, переключаемся на локальный Whisper:', e);
    }
  }

  // Локальный инференс через Transformers.js
  const pipe = await getAsrPipe();
  const res = await pipe(pcm, {
    language: 'russian',
    task: 'transcribe',
    return_timestamps: false,
    chunk_length_s: 30,
    stride_length_s: 5,
    max_new_tokens: 448,
    repetition_penalty: 1.1,
  });

  let raw = '';
  if (Array.isArray(res)) raw = res.map((r) => (r && r.text) || '').join(' ').trim();
  else raw = ((res && res.text) || '').trim();

  return cleanWhisperText(raw);
}

async function recognizeAudioBase64(base64, apiKey) {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

  const cleanKey = (apiKey || '').trim();
  if (cleanKey.startsWith('gsk_') || cleanKey.startsWith('sk-')) {
    try {
      const blob = new Blob([bytes], { type: 'audio/webm' });
      return await transcribeViaCloudApi(blob, cleanKey, RUSSIAN_ASR_PROMPT);
    } catch (e) {
      console.warn('Ошибка Cloud API в recognizeAudioBase64, переключаемся на локальный декодер:', e);
    }
  }

  const AC = window.AudioContext || window.webkitAudioContext;
  const ac = new AC();
  const decoded = await ac.decodeAudioData(bytes.buffer.slice(0));
  return transcribeSegment(decoded, 0, decoded.duration, apiKey);
}

async function recognizeAudioFromUrl(url, headTo, tailFrom, tailTo, apiKey) {
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

  const headText = await transcribeSegment(decoded, 0, headTo, apiKey);
  const tailText = await transcribeSegment(decoded, tailFrom, Math.min(decoded.duration, tailTo), apiKey);
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
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true;
  }

  if (msg.type === 'asrDo') {
    (async () => {
      try {
        const text = await recognizeAudioBase64(msg.audio, msg.apiKey);
        sendResponse({ ok: true, text });
      } catch (e) {
        asrPipe = null;
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true;
  }

  if (msg.type === 'asrDoUrl') {
    (async () => {
      try {
        const res = await recognizeAudioFromUrl(msg.url, msg.headTo, msg.tailFrom, msg.tailTo, msg.apiKey);
        sendResponse({ ok: true, headText: res.headText, tailText: res.tailText });
      } catch (e) {
        asrPipe = null;
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true;
  }

  return false;
});
