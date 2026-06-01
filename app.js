import { FFmpeg } from './vendor/ffmpeg/index.js';
import { fetchFile } from 'https://unpkg.com/@ffmpeg/util@0.12.1/dist/esm/index.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);
function show(id) { $(id).classList.remove('hidden'); }
function hide(id) { $(id).classList.add('hidden'); }
function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ─── FFmpeg (shared) ─────────────────────────────────────────────────────────

const ffmpeg = new FFmpeg();
let ffmpegLoaded = false;
let currentItem = null;
let lastLogs = [];

ffmpeg.on('log', ({ message }) => {
  lastLogs.push(message);
  if (lastLogs.length > 20) lastLogs.shift();
});

ffmpeg.on('progress', ({ progress }) => {
  if (currentItem) setItemProgress(currentItem, Math.min(Math.round(progress * 100), 99));
});

async function loadFFmpeg() {
  if (ffmpegLoaded) return;
  show('loading-section');
  const base = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm';
  await ffmpeg.load({ coreURL: `${base}/ffmpeg-core.js`, wasmURL: `${base}/ffmpeg-core.wasm` });
  ffmpegLoaded = true;
  hide('loading-section');
}

// ─── Shared queue item UI ────────────────────────────────────────────────────

let nextId = 0;

function createQueueItem(item, listEl) {
  const li = document.createElement('li');
  li.className = 'queue-item';
  li.id = `qi-${item.id}`;
  li.innerHTML = `
    <div class="qi-top">
      <span class="qi-name">${escapeHtml(item.label)}</span>
      <span class="qi-status status-waiting">Waiting</span>
    </div>
    <div class="qi-progress hidden">
      <div class="progress-bar"><div class="bar" style="width:0%"></div></div>
      <span class="qi-pct">0%</span>
    </div>
    <a class="qi-download hidden">Download</a>
  `;
  listEl.appendChild(li);
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
      downloadEl.download = item.downloadName;
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

// ─── CROP TAB ────────────────────────────────────────────────────────────────

const cropQueue = [];
let cropProcessing = false;

function enqueueCropFiles(files) {
  const allowed = ['.mp4', '.mov', '.mkv'];
  for (const file of files) {
    const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
    const item = { file, id: nextId++, state: 'waiting', label: file.name };
    cropQueue.push(item);
    createQueueItem(item, $('queue-list'));
    if (!allowed.includes(ext)) {
      item.state = 'error';
      item.error = 'Use MP4, MOV, or MKV';
      updateQueueItem(item);
    }
  }
  processNextCrop();
}

async function processNextCrop() {
  if (cropProcessing) return;
  const next = cropQueue.find(i => i.state === 'waiting');
  if (!next) return;
  cropProcessing = true;
  try {
    await loadFFmpeg();
    await cropVideo(next);
  } catch (e) {
    next.state = 'error';
    next.error = e.message || 'Unknown error';
    currentItem = null;
    updateQueueItem(next);
  }
  cropProcessing = false;
  processNextCrop();
}

async function cropVideo(item) {
  item.state = 'processing';
  currentItem = item;
  updateQueueItem(item);
  const ext = item.file.name.slice(item.file.name.lastIndexOf('.')).toLowerCase();
  const inName = `crop_in_${item.id}${ext}`;
  const outName = `crop_out_${item.id}.mp4`;
  await ffmpeg.writeFile(inName, await fetchFile(item.file));
  try {
    await ffmpeg.exec([
      '-i', inName,
      '-vf', 'crop=iw:iw*5/4:0:(ih-iw*5/4)/2',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
      '-c:a', 'copy',
      outName,
    ]);
    setItemProgress(item, 100);
    const data = await ffmpeg.readFile(outName);
    item.blobUrl = URL.createObjectURL(new Blob([data], { type: 'video/mp4' }));
    const base = item.file.name.slice(0, item.file.name.lastIndexOf('.'));
    item.downloadName = `${base}_4x5.mp4`;
    item.state = 'done';
    updateQueueItem(item);
  } finally {
    currentItem = null;
    try { await ffmpeg.deleteFile(inName); } catch (_) {}
    try { await ffmpeg.deleteFile(outName); } catch (_) {}
  }
}

// ─── STITCH TAB ───────────────────────────────────────────────────────────────

let stitchBaseFile = null;
let stitchHookFiles = [];
const stitchQueue = [];
let stitchProcessing = false;
let stitchBaseInWasm = null;

function setBaseFile(file) {
  stitchBaseFile = file;
  const drop = $('base-drop');
  drop.classList.toggle('has-file', !!file);
  $('base-drop-text').textContent = file ? `✓  ${file.name}` : 'Drop base video or click';
  updateStitchBtn();
}

function setHookFiles(files) {
  const allowed = ['.mp4', '.mov', '.mkv'];
  stitchHookFiles = Array.from(files).filter(f => {
    const ext = f.name.slice(f.name.lastIndexOf('.')).toLowerCase();
    return allowed.includes(ext);
  });

  const drop = $('hooks-drop');
  const text = $('hooks-drop-text');
  const hint = $('hooks-hint');

  if (stitchHookFiles.length > 0) {
    drop.classList.add('has-file');
    text.textContent = `✓  ${stitchHookFiles.length} hook${stitchHookFiles.length !== 1 ? 's' : ''} loaded — drop to replace`;
    hint.classList.add('hidden');
  } else {
    drop.classList.remove('has-file');
    text.textContent = 'Drop all hooks here or click';
    hint.classList.remove('hidden');
  }

  renderHooksList();
  updateStitchBtn();
}

function renderHooksList() {
  const list = $('hooks-list');
  list.innerHTML = '';
  stitchHookFiles.forEach((file, i) => {
    const li = document.createElement('li');
    li.className = 'hook-list-item';
    li.innerHTML = `<span class="hook-num">Hook ${i + 1}</span><span class="hook-filename">${escapeHtml(file.name)}</span>`;
    list.appendChild(li);
  });
}

function updateStitchBtn() {
  $('stitch-btn').disabled = !(stitchBaseFile && stitchHookFiles.length > 0);
}

function startStitch() {
  if (!stitchBaseFile || stitchHookFiles.length === 0) return;
  const baseName = stitchBaseFile.name.slice(0, stitchBaseFile.name.lastIndexOf('.'));

  $('stitch-queue').innerHTML = '';
  stitchQueue.length = 0;
  stitchBaseInWasm = null;

  stitchHookFiles.forEach((hookFile, i) => {
    const item = {
      hookFile,
      baseFile: stitchBaseFile,
      id: nextId++,
      state: 'waiting',
      label: `${baseName}_hook_${i + 1}.mp4`,
      downloadName: `${baseName}_hook_${i + 1}.mp4`,
    };
    stitchQueue.push(item);
    createQueueItem(item, $('stitch-queue'));
  });

  processNextStitch();
}

async function processNextStitch() {
  if (stitchProcessing) return;
  const next = stitchQueue.find(i => i.state === 'waiting');
  if (!next) {
    if (stitchBaseInWasm) {
      try { await ffmpeg.deleteFile(stitchBaseInWasm); } catch (_) {}
      stitchBaseInWasm = null;
    }
    return;
  }
  stitchProcessing = true;
  try {
    await loadFFmpeg();
    if (!stitchBaseInWasm) {
      const baseExt = next.baseFile.name.slice(next.baseFile.name.lastIndexOf('.')).toLowerCase();
      stitchBaseInWasm = `stitch_base${baseExt}`;
      await ffmpeg.writeFile(stitchBaseInWasm, await fetchFile(next.baseFile));
    }
    await stitchPair(next, stitchBaseInWasm);
  } catch (e) {
    next.state = 'error';
    next.error = e.message || 'Unknown error';
    currentItem = null;
    updateQueueItem(next);
  }
  stitchProcessing = false;
  processNextStitch();
}

async function stitchPair(item, baseInWasm) {
  item.state = 'processing';
  currentItem = item;
  updateQueueItem(item);

  const hookExt = item.hookFile.name.slice(item.hookFile.name.lastIndexOf('.')).toLowerCase();
  const hookName = `stitch_hook_${item.id}${hookExt}`;
  const outName = `stitch_out_${item.id}.mp4`;

  const listName = `stitch_list_${item.id}.txt`;
  await ffmpeg.writeFile(hookName, await fetchFile(item.hookFile));
  await ffmpeg.writeFile(listName, `file '${hookName}'\nfile '${baseInWasm}'\n`);
  try {
    lastLogs = [];
    const ret = await ffmpeg.exec([
      '-f', 'concat',
      '-safe', '0',
      '-i', listName,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
      '-c:a', 'aac',
      '-y',
      outName,
    ]);
    if (ret !== 0) {
      const hint = lastLogs.filter(l => l.includes('Error') || l.includes('error') || l.includes('Invalid')).slice(-2).join(' | ');
      throw new Error(`FFmpeg failed (code ${ret})${hint ? ': ' + hint : '. Videos may have incompatible formats.'}`);
    }
    setItemProgress(item, 100);
    const data = await ffmpeg.readFile(outName);
    item.blobUrl = URL.createObjectURL(new Blob([data], { type: 'video/mp4' }));
    item.state = 'done';
    updateQueueItem(item);
  } finally {
    currentItem = null;
    try { await ffmpeg.deleteFile(hookName); } catch (_) {}
    try { await ffmpeg.deleteFile(outName); } catch (_) {}
    try { await ffmpeg.deleteFile(listName); } catch (_) {}
  }
}

// ─── Tab switching ────────────────────────────────────────────────────────────

function switchTab(name) {
  document.querySelectorAll('.tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === name);
  });
  $('crop-panel').classList.toggle('hidden', name !== 'crop');
  $('stitch-panel').classList.toggle('hidden', name !== 'stitch');
}

// ─── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  // Crop
  const dropZone = $('drop-zone');
  const fileInput = $('file-input');
  dropZone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', e => {
    if (e.target.files.length) enqueueCropFiles(Array.from(e.target.files));
    fileInput.value = '';
  });
  dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    if (e.dataTransfer.files.length) enqueueCropFiles(Array.from(e.dataTransfer.files));
  });

  // Stitch — base
  const baseDrop = $('base-drop');
  const baseInput = $('base-input');
  baseDrop.addEventListener('click', () => baseInput.click());
  baseDrop.addEventListener('dragover', e => { e.preventDefault(); baseDrop.classList.add('drag-over'); });
  baseDrop.addEventListener('dragleave', () => baseDrop.classList.remove('drag-over'));
  baseDrop.addEventListener('drop', e => {
    e.preventDefault();
    baseDrop.classList.remove('drag-over');
    if (e.dataTransfer.files[0]) setBaseFile(e.dataTransfer.files[0]);
  });
  baseInput.addEventListener('change', e => {
    if (e.target.files[0]) setBaseFile(e.target.files[0]);
    baseInput.value = '';
  });

  // Stitch — hooks
  const hooksDrop = $('hooks-drop');
  const hooksInput = $('hooks-input');
  hooksDrop.addEventListener('click', () => hooksInput.click());
  hooksDrop.addEventListener('dragover', e => { e.preventDefault(); hooksDrop.classList.add('drag-over'); });
  hooksDrop.addEventListener('dragleave', () => hooksDrop.classList.remove('drag-over'));
  hooksDrop.addEventListener('drop', e => {
    e.preventDefault();
    hooksDrop.classList.remove('drag-over');
    if (e.dataTransfer.files.length) setHookFiles(e.dataTransfer.files);
  });
  hooksInput.addEventListener('change', e => {
    if (e.target.files.length) setHookFiles(e.target.files);
    hooksInput.value = '';
  });

  $('stitch-btn').addEventListener('click', startStitch);

  // Tabs
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
});
