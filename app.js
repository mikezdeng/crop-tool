import { FFmpeg } from 'https://unpkg.com/@ffmpeg/ffmpeg@0.12.6/dist/esm/index.js';
import { fetchFile, toBlobURL } from 'https://unpkg.com/@ffmpeg/util@0.12.1/dist/esm/index.js';

// Pure function: documents and tests the 9:16 → 4:5 center-crop math.
// The FFmpeg exec below uses equivalent native expressions (crop=iw:iw*5/4:...)
// so no dimension probing is needed at runtime.
function getCropParams(inputWidth, inputHeight) {
  const outHeight = Math.floor(inputWidth * 5 / 4);
  const yOffset = Math.floor((inputHeight - outHeight) / 2);
  return `crop=${inputWidth}:${outHeight}:0:${yOffset}`;
}

// Self-tests
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

// DOM helpers
const $ = (id) => document.getElementById(id);
function show(id) { $(id).classList.remove('hidden'); }
function hide(id) { $(id).classList.add('hidden'); }
function setBar(barId, pctId, pct) {
  $(barId).style.width = `${pct}%`;
  if (pctId) $(pctId).textContent = `${pct}%`;
}

// FFmpeg state
const ffmpeg = new FFmpeg();
let ffmpegLoaded = false;
let onProgress = null;

// Single persistent progress listener — callback swapped per-operation
ffmpeg.on('progress', ({ progress }) => {
  if (onProgress) onProgress(progress);
});

async function loadFFmpeg() {
  if (ffmpegLoaded) return;
  show('loading-section');
  const base = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm';
  await ffmpeg.load({
    coreURL: await toBlobURL(`${base}/ffmpeg-core.js`, 'text/javascript'),
    wasmURL: await toBlobURL(`${base}/ffmpeg-core.wasm`, 'application/wasm'),
  });
  ffmpegLoaded = true;
  hide('loading-section');
}

async function cropVideo(file) {
  show('processing-section');
  setBar('crop-bar', 'crop-pct', 0);

  onProgress = (progress) => {
    setBar('crop-bar', 'crop-pct', Math.min(Math.round(progress * 100), 99));
  };

  const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
  const inputName = `input${ext}`;
  const outputName = 'output.mp4';

  await ffmpeg.writeFile(inputName, await fetchFile(file));
  await ffmpeg.exec([
    '-i', inputName,
    '-vf', 'crop=iw:iw*5/4:0:(ih-iw*5/4)/2',
    '-c:a', 'copy',
    outputName,
  ]);

  onProgress = null;
  setBar('crop-bar', 'crop-pct', 100);

  const data = await ffmpeg.readFile(outputName);
  const blob = new Blob([data.buffer], { type: 'video/mp4' });
  const url = URL.createObjectURL(blob);

  const baseName = file.name.slice(0, file.name.lastIndexOf('.'));
  const btn = $('download-btn');
  btn.href = url;
  btn.download = `${baseName}_4x5.mp4`;

  await ffmpeg.deleteFile(inputName);
  await ffmpeg.deleteFile(outputName);

  hide('processing-section');
  show('download-section');
}

function showError(msg) {
  hide('loading-section');
  hide('processing-section');
  $('error-msg').textContent = msg;
  show('error-section');
}

function resetUI() {
  ['download-section', 'error-section', 'processing-section'].forEach(hide);
  show('drop-zone');
  $('file-input').value = '';
  const btn = $('download-btn');
  if (btn.href && btn.href.startsWith('blob:')) URL.revokeObjectURL(btn.href);
  btn.removeAttribute('href');
}

async function handleFile(file) {
  const allowedExts = ['.mp4', '.mov', '.mkv'];
  const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
  if (!allowedExts.includes(ext)) {
    showError(`Unsupported file: ${file.name}. Use MP4, MOV, or MKV.`);
    return;
  }
  hide('drop-zone');
  try {
    await loadFFmpeg();
    await cropVideo(file);
  } catch (err) {
    showError(`Something went wrong: ${err.message || 'Unknown error'}`);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const dropZone = $('drop-zone');
  const fileInput = $('file-input');

  dropZone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', (e) => {
    if (e.target.files[0]) handleFile(e.target.files[0]);
  });

  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
  });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
  });

  $('reset-btn').addEventListener('click', resetUI);
  $('error-reset-btn').addEventListener('click', resetUI);
});
