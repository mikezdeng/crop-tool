import { FFmpeg } from './vendor/ffmpeg/index.js';
import { fetchFile } from 'https://unpkg.com/@ffmpeg/util@0.12.1/dist/esm/index.js';

function getCropParams(inputWidth, inputHeight) {
  const outHeight = Math.floor(inputWidth * 5 / 4);
  const yOffset = Math.floor((inputHeight - outHeight) / 2);
  return `crop=${inputWidth}:${outHeight}:0:${yOffset}`;
}

(function selfTest() {
  try {
    const a = getCropParams(1080, 1920);
    console.assert(a === 'crop=1080:1350:0:285', `FAIL: got ${a}`);
    const b = getCropParams(720, 1280);
    console.assert(b === 'crop=720:900:0:190', `FAIL: got ${b}`);
    console.log('[CropTool] Self-tests passed.');
  } catch (e) {
    console.error('[CropTool] Self-tests FAILED:', e.message);
  }
})();

const $ = (id) => document.getElementById(id);
function show(id) { $(id).classList.remove('hidden'); }
function hide(id) { $(id).classList.add('hidden'); }

// FFmpeg — single instance, loaded once
const ffmpeg = new FFmpeg();
let ffmpegLoaded = false;

// Single persistent progress listener — delegates to whichever item is currently processing
let currentItem = null;
ffmpeg.on('progress', ({ progress }) => {
  if (currentItem) setItemProgress(currentItem, Math.min(Math.round(progress * 100), 99));
});

async function loadFFmpeg() {
  if (ffmpegLoaded) return;
  show('loading-section');
  const base = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm';
  await ffmpeg.load({
    coreURL: `${base}/ffmpeg-core.js`,
    wasmURL: `${base}/ffmpeg-core.wasm`,
  });
  ffmpegLoaded = true;
  hide('loading-section');
}

// Queue
const queue = [];
let isProcessing = false;
let nextId = 0;

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function createQueueItem(item) {
  const li = document.createElement('li');
  li.className = 'queue-item';
  li.id = `qi-${item.id}`;
  li.innerHTML = `
    <div class="qi-top">
      <span class="qi-name">${escapeHtml(item.file.name)}</span>
      <span class="qi-status status-waiting">Waiting</span>
    </div>
    <div class="qi-progress hidden">
      <div class="progress-bar"><div class="bar" style="width:0%"></div></div>
      <span class="qi-pct">0%</span>
    </div>
    <a class="qi-download hidden">Download</a>
  `;
  $('queue-list').appendChild(li);
}

function updateQueueItem(item) {
  const li = $(`qi-${item.id}`);
  if (!li) return;
  const statusEl = li.querySelector('.qi-status');
  const progressEl = li.querySelector('.qi-progress');
  const downloadEl = li.querySelector('.qi-download');

  statusEl.className = 'qi-status';
  progressEl.classList.add('hidden');
  downloadEl.classList.add('hidden');

  switch (item.state) {
    case 'waiting':
      statusEl.classList.add('status-waiting');
      statusEl.textContent = 'Waiting';
      break;
    case 'processing':
      statusEl.classList.add('status-processing');
      statusEl.textContent = 'Processing';
      progressEl.classList.remove('hidden');
      break;
    case 'done':
      statusEl.classList.add('status-done');
      statusEl.textContent = 'Done ✓';
      downloadEl.classList.remove('hidden');
      downloadEl.href = item.blobUrl;
      const baseName = item.file.name.slice(0, item.file.name.lastIndexOf('.'));
      downloadEl.download = `${baseName}_4x5.mp4`;
      break;
    case 'error':
      statusEl.classList.add('status-error');
      statusEl.textContent = `Error: ${item.error || 'unknown'}`;
      break;
  }
}

function setItemProgress(item, pct) {
  const li = $(`qi-${item.id}`);
  if (!li) return;
  li.querySelector('.bar').style.width = `${pct}%`;
  li.querySelector('.qi-pct').textContent = `${pct}%`;
}

async function cropVideo(item) {
  item.state = 'processing';
  currentItem = item;
  updateQueueItem(item);

  const ext = item.file.name.slice(item.file.name.lastIndexOf('.')).toLowerCase();
  const inputName = `input_${item.id}${ext}`;
  const outputName = `output_${item.id}.mp4`;

  await ffmpeg.writeFile(inputName, await fetchFile(item.file));
  try {
    await ffmpeg.exec([
      '-i', inputName,
      '-vf', 'crop=iw:iw*5/4:0:(ih-iw*5/4)/2',
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-crf', '23',
      '-c:a', 'copy',
      outputName,
    ]);

    setItemProgress(item, 100);

    const data = await ffmpeg.readFile(outputName);
    const blob = new Blob([data], { type: 'video/mp4' });
    item.blobUrl = URL.createObjectURL(blob);
    item.state = 'done';
    updateQueueItem(item);
  } finally {
    currentItem = null;
    try { await ffmpeg.deleteFile(inputName); } catch (_) {}
    try { await ffmpeg.deleteFile(outputName); } catch (_) {}
  }
}

async function processNext() {
  if (isProcessing) return;
  const next = queue.find(i => i.state === 'waiting');
  if (!next) return;
  isProcessing = true;
  try {
    await loadFFmpeg();
    await cropVideo(next);
  } catch (e) {
    next.state = 'error';
    next.error = e.message || 'Unknown error';
    currentItem = null;
    updateQueueItem(next);
  }
  isProcessing = false;
  processNext();
}

function enqueueFiles(files) {
  const allowed = ['.mp4', '.mov', '.mkv'];
  for (const file of files) {
    const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
    const item = { file, id: nextId++, state: 'waiting' };
    queue.push(item);
    createQueueItem(item);
    if (!allowed.includes(ext)) {
      item.state = 'error';
      item.error = 'Use MP4, MOV, or MKV';
      updateQueueItem(item);
    }
  }
  processNext();
}

document.addEventListener('DOMContentLoaded', () => {
  const dropZone = $('drop-zone');
  const fileInput = $('file-input');

  dropZone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', (e) => {
    if (e.target.files.length) enqueueFiles(Array.from(e.target.files));
    fileInput.value = '';
  });

  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
  });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    if (e.dataTransfer.files.length) enqueueFiles(Array.from(e.dataTransfer.files));
  });
});
