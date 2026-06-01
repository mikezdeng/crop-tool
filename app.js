// WebCodecs-powered video processor — no FFmpeg, no WASM, no cold start

const $ = id => document.getElementById(id);
const show = id => $(id).classList.remove('hidden');
const hide = id => $(id).classList.add('hidden');
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ─── mp4box demux ─────────────────────────────────────────────────────────────

function demuxFile(file) {
  return new Promise((resolve, reject) => {
    const box = MP4Box.createFile();
    let vTrack = null, aTrack = null;
    const vSamples = [], aSamples = [];

    box.onReady = info => {
      vTrack = info.videoTracks[0] ?? null;
      aTrack = info.audioTracks[0] ?? null;
      if (vTrack) box.setExtractionOptions(vTrack.id, null, { nbSamples: Infinity });
      if (aTrack) box.setExtractionOptions(aTrack.id, null, { nbSamples: Infinity });
      box.start();
    };

    box.onSamples = (id, _, s) => {
      if (vTrack && id === vTrack.id) vSamples.push(...s);
      else if (aTrack && id === aTrack.id) aSamples.push(...s);
    };

    box.onFlush = () => resolve({ box, vTrack, aTrack, vSamples, aSamples });
    box.onError = e => reject(new Error(String(e)));

    file.arrayBuffer().then(ab => {
      ab.fileStart = 0;
      box.appendBuffer(ab);
      box.flush();
    }, reject);
  });
}

function getExtradata(box, track) {
  try {
    // DataStream is on MP4Box in browser builds, not a bare global
    const DS = MP4Box.DataStream;
    if (!DS) return undefined;
    const trak = box.moov.traks.find(t => t.tkhd.track_id === track.id);
    const entry = trak?.mdia?.minf?.stbl?.stsd?.entries?.[0];
    if (!entry) return undefined;
    const b = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
    if (!b) return undefined;
    const ds = new DS(undefined, 0, DS.BIG_ENDIAN);
    b.write(ds);
    return new Uint8Array(ds.buffer, 8);
  } catch { return undefined; }
}

function makeAsc(sampleRate, channels) {
  const rates = [96000,88200,64000,48000,44100,32000,24000,22050,16000,12000,11025,8000,7350];
  const idx = rates.indexOf(sampleRate);
  if (idx < 0) return null;
  return new Uint8Array([(2 << 3) | (idx >> 1), ((idx & 1) << 7) | (channels << 3)]);
}

// ─── Queue UI ─────────────────────────────────────────────────────────────────

let nextId = 0, currentItem = null;

function createQueueItem(item, listEl) {
  const li = document.createElement('li');
  li.className = 'queue-item';
  li.id = `qi-${item.id}`;
  li.innerHTML = `
    <div class="qi-top">
      <span class="qi-name">${esc(item.label)}</span>
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
  const s = li.querySelector('.qi-status');
  const p = li.querySelector('.qi-progress');
  const d = li.querySelector('.qi-download');
  s.className = 'qi-status'; p.classList.add('hidden'); d.classList.add('hidden');
  if (item.state === 'waiting')    { s.classList.add('status-waiting');    s.textContent = 'Waiting'; }
  if (item.state === 'processing') { s.classList.add('status-processing'); s.textContent = 'Processing'; p.classList.remove('hidden'); }
  if (item.state === 'done')       { s.classList.add('status-done');       s.textContent = 'Done ✓'; d.classList.remove('hidden'); d.href = item.blobUrl; d.download = item.downloadName; }
  if (item.state === 'error')      { s.classList.add('status-error');      s.textContent = `Error: ${item.error || 'unknown'}`; }
}

function setItemProgress(item, pct) {
  const li = $(`qi-${item.id}`);
  if (!li) return;
  li.querySelector('.bar').style.width = `${pct}%`;
  li.querySelector('.qi-pct').textContent = `${pct}%`;
}

// ─── Core encode pipeline ─────────────────────────────────────────────────────

async function encodeFrames({ box, vTrack, samples, encoder, tsOffset, frameStart, totalFrames, onProgress, processFrame }) {
  let frameIdx = frameStart;
  let decErr = null;

  await new Promise((resolve, reject) => {
    const decoder = new VideoDecoder({
      output: frame => {
        try {
          const ts = frame.timestamp + tsOffset;
          const outFrame = processFrame(frame, ts);
          encoder.encode(outFrame, { keyFrame: frameIdx === frameStart || frameIdx % 60 === 0 });
          outFrame.close();
          frameIdx++;
          onProgress?.(frameIdx / totalFrames);
        } catch (e) { decErr = e; }
      },
      error: reject,
    });

    const extradata = getExtradata(box, vTrack);
    decoder.configure({
      codec: vTrack.codec,
      codedWidth: vTrack.video.width,
      codedHeight: vTrack.video.height,
      ...(extradata && { description: extradata }),
    });

    for (const s of samples) {
      decoder.decode(new EncodedVideoChunk({
        type: s.is_sync ? 'key' : 'delta',
        timestamp: s.cts * 1_000_000 / vTrack.timescale,
        duration: s.duration * 1_000_000 / vTrack.timescale,
        data: s.data,
      }));
    }
    decoder.flush().then(resolve, reject);
  });

  if (decErr) throw decErr;
  return frameIdx;
}

function addAudioPassthrough(muxer, aTrack, samples, tsOffset) {
  if (!aTrack || !samples.length) return;
  const asc = makeAsc(aTrack.audio.sample_rate, aTrack.audio.channel_count);
  const meta = asc ? { decoderConfig: { codec: aTrack.codec, description: asc } } : undefined;
  for (const s of samples) {
    muxer.addAudioChunkRaw(new EncodedAudioChunk({
      type: 'key',
      timestamp: s.cts * 1_000_000 / aTrack.timescale + tsOffset,
      duration: s.duration * 1_000_000 / aTrack.timescale,
      data: s.data,
    }), meta);
  }
}

function makeEncoder(muxer, W, H) {
  let encErr = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: e => { encErr = e; },
  });
  encoder.configure({
    codec: 'avc1.4d0029',
    width: W,
    height: H,
    bitrate: 4_000_000,
    hardwareAcceleration: 'prefer-hardware',
  });
  return { encoder, getErr: () => encErr };
}

function makeMuxer(W, H, aTrack) {
  const target = new Mp4Muxer.ArrayBufferTarget();
  const muxer = new Mp4Muxer.Muxer({
    target,
    video: { codec: 'avc', width: W, height: H },
    ...(aTrack && { audio: { codec: 'aac', sampleRate: aTrack.audio.sample_rate, numberOfChannels: aTrack.audio.channel_count } }),
    firstTimestampBehavior: 'offset',
  });
  return { muxer, target };
}

function evenDim(n) { return n % 2 === 0 ? n : n - 1; }

// ─── CROP TAB ─────────────────────────────────────────────────────────────────

const cropQueue = [];
let cropProcessing = false;

function enqueueCropFiles(files) {
  const ok = ['.mp4', '.mov', '.mkv'];
  for (const f of files) {
    const ext = f.name.slice(f.name.lastIndexOf('.')).toLowerCase();
    const item = { file: f, id: nextId++, state: 'waiting', label: f.name };
    cropQueue.push(item);
    createQueueItem(item, $('queue-list'));
    if (!ok.includes(ext)) { item.state = 'error'; item.error = 'Use MP4, MOV, or MKV'; updateQueueItem(item); }
  }
  processNextCrop();
}

async function processNextCrop() {
  if (cropProcessing) return;
  const next = cropQueue.find(i => i.state === 'waiting');
  if (!next) return;
  cropProcessing = true;
  await cropVideo(next);
  cropProcessing = false;
  processNextCrop();
}

async function cropVideo(item) {
  item.state = 'processing'; currentItem = item; updateQueueItem(item);
  try {
    const { box, vTrack, aTrack, vSamples, aSamples } = await demuxFile(item.file);
    if (!vTrack) throw new Error('No video track found');

    const inW = vTrack.video.width, inH = vTrack.video.height;
    const outW = evenDim(inW);
    const outH = evenDim(Math.round(outW * 5 / 4));
    const cropY = Math.round((inH - outH) / 2);

    const { muxer, target } = makeMuxer(outW, outH, aTrack);
    const { encoder, getErr } = makeEncoder(muxer, outW, outH);

    const canvas = new OffscreenCanvas(outW, outH);
    const ctx = canvas.getContext('2d');

    await encodeFrames({
      box, vTrack, samples: vSamples, encoder, tsOffset: 0,
      frameStart: 0, totalFrames: vSamples.length,
      onProgress: p => setItemProgress(item, Math.round(p * 90)),
      processFrame: (frame, ts) => {
        ctx.drawImage(frame, 0, -cropY, inW, inH);
        frame.close();
        return new VideoFrame(canvas, { timestamp: ts });
      },
    });

    await encoder.flush();
    if (getErr()) throw getErr();

    addAudioPassthrough(muxer, aTrack, aSamples, 0);
    muxer.finalize();

    setItemProgress(item, 100);
    item.blobUrl = URL.createObjectURL(new Blob([target.buffer], { type: 'video/mp4' }));
    item.downloadName = `${item.file.name.slice(0, item.file.name.lastIndexOf('.'))}_4x5.mp4`;
    item.state = 'done';
    updateQueueItem(item);
  } catch (e) {
    item.state = 'error'; item.error = e.message || 'Unknown error'; updateQueueItem(item);
  } finally { currentItem = null; }
}

// ─── STITCH TAB ───────────────────────────────────────────────────────────────

let stitchBaseFile = null, stitchHookFiles = [];
const stitchQueue = [];
let stitchProcessing = false, stitchBaseData = null;

function setBaseFile(file) {
  stitchBaseFile = file; stitchBaseData = null;
  $('base-drop').classList.toggle('has-file', !!file);
  $('base-drop-text').textContent = file ? `✓  ${file.name}` : 'Drop base video or click';
  updateStitchBtn();
}

function setHookFiles(files) {
  const ok = ['.mp4', '.mov', '.mkv'];
  stitchHookFiles = Array.from(files).filter(f => ok.includes(f.name.slice(f.name.lastIndexOf('.')).toLowerCase()));
  const drop = $('hooks-drop'), text = $('hooks-drop-text'), hint = $('hooks-hint');
  if (stitchHookFiles.length > 0) {
    drop.classList.add('has-file');
    text.textContent = `✓  ${stitchHookFiles.length} hook${stitchHookFiles.length !== 1 ? 's' : ''} loaded — drop to replace`;
    hint.classList.add('hidden');
  } else {
    drop.classList.remove('has-file');
    text.textContent = 'Drop all hooks here or click';
    hint.classList.remove('hidden');
  }
  renderHooksList(); updateStitchBtn();
}

function renderHooksList() {
  const list = $('hooks-list');
  list.innerHTML = '';
  stitchHookFiles.forEach((f, i) => {
    const li = document.createElement('li');
    li.className = 'hook-list-item';
    li.innerHTML = `<span class="hook-num">Hook ${i + 1}</span><span class="hook-filename">${esc(f.name)}</span>`;
    list.appendChild(li);
  });
}

function updateStitchBtn() {
  $('stitch-btn').disabled = !(stitchBaseFile && stitchHookFiles.length > 0);
}

function startStitch() {
  if (!stitchBaseFile || stitchHookFiles.length === 0) return;
  const baseName = stitchBaseFile.name.slice(0, stitchBaseFile.name.lastIndexOf('.'));
  $('stitch-queue').innerHTML = ''; stitchQueue.length = 0; stitchBaseData = null;
  stitchHookFiles.forEach((hookFile, i) => {
    const item = { hookFile, id: nextId++, state: 'waiting', label: `${baseName}_hook_${i + 1}.mp4`, downloadName: `${baseName}_hook_${i + 1}.mp4` };
    stitchQueue.push(item);
    createQueueItem(item, $('stitch-queue'));
  });
  processNextStitch();
}

async function processNextStitch() {
  if (stitchProcessing) return;
  const next = stitchQueue.find(i => i.state === 'waiting');
  if (!next) { stitchBaseData = null; return; }
  stitchProcessing = true;
  try {
    if (!stitchBaseData) stitchBaseData = await demuxFile(stitchBaseFile);
    await stitchPair(next, stitchBaseData);
  } catch (e) {
    next.state = 'error'; next.error = e.message || 'Unknown error';
    currentItem = null; updateQueueItem(next);
  }
  stitchProcessing = false;
  processNextStitch();
}

async function stitchPair(item, baseData) {
  item.state = 'processing'; currentItem = item; updateQueueItem(item);
  try {
    const hookData = await demuxFile(item.hookFile);
    const { box: hBox, vTrack: hVT, aTrack: hAT, vSamples: hVS, aSamples: hAS } = hookData;
    const { box: bBox, vTrack: bVT, aTrack: bAT, vSamples: bVS, aSamples: bAS } = baseData;
    if (!hVT || !bVT) throw new Error('Missing video track');

    const W = evenDim(bVT.video.width), H = evenDim(bVT.video.height);

    const lastHV = hVS[hVS.length - 1];
    const hookVideoDuration = (lastHV.cts + lastHV.duration) * 1_000_000 / hVT.timescale;

    const { muxer, target } = makeMuxer(W, H, hAT || bAT);
    const { encoder, getErr } = makeEncoder(muxer, W, H);

    const canvas = new OffscreenCanvas(W, H);
    const ctx = canvas.getContext('2d');
    const drawFrame = (frame, ts) => {
      ctx.drawImage(frame, 0, 0, W, H);
      frame.close();
      return new VideoFrame(canvas, { timestamp: ts });
    };

    const totalFrames = hVS.length + bVS.length;

    const frameIdx = await encodeFrames({
      box: hBox, vTrack: hVT, samples: hVS, encoder, tsOffset: 0,
      frameStart: 0, totalFrames,
      onProgress: p => setItemProgress(item, Math.round(p * 90)),
      processFrame: drawFrame,
    });

    await encodeFrames({
      box: bBox, vTrack: bVT, samples: bVS, encoder, tsOffset: hookVideoDuration,
      frameStart: frameIdx, totalFrames,
      onProgress: p => setItemProgress(item, Math.round(p * 90)),
      processFrame: drawFrame,
    });

    await encoder.flush();
    if (getErr()) throw getErr();

    addAudioPassthrough(muxer, hAT, hAS, 0);

    const lastHA = hAS.length > 0 ? hAS[hAS.length - 1] : null;
    const hookAudioDuration = lastHA && hAT
      ? (lastHA.cts + lastHA.duration) * 1_000_000 / hAT.timescale
      : hookVideoDuration;
    addAudioPassthrough(muxer, bAT, bAS, hookAudioDuration);

    muxer.finalize();
    setItemProgress(item, 100);
    item.blobUrl = URL.createObjectURL(new Blob([target.buffer], { type: 'video/mp4' }));
    item.state = 'done'; updateQueueItem(item);
  } catch (e) {
    item.state = 'error'; item.error = e.message || 'Unknown error'; updateQueueItem(item);
  } finally { currentItem = null; }
}

// ─── Tab switching ────────────────────────────────────────────────────────────

function switchTab(name) {
  document.querySelectorAll('.tab').forEach(btn => btn.classList.toggle('active', btn.dataset.tab === name));
  $('crop-panel').classList.toggle('hidden', name !== 'crop');
  $('stitch-panel').classList.toggle('hidden', name !== 'stitch');
}

// ─── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  const dropZone = $('drop-zone'), fileInput = $('file-input');
  dropZone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', e => { if (e.target.files.length) enqueueCropFiles(Array.from(e.target.files)); fileInput.value = ''; });
  dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', e => { e.preventDefault(); dropZone.classList.remove('drag-over'); if (e.dataTransfer.files.length) enqueueCropFiles(Array.from(e.dataTransfer.files)); });

  const baseDrop = $('base-drop'), baseInput = $('base-input');
  baseDrop.addEventListener('click', () => baseInput.click());
  baseDrop.addEventListener('dragover', e => { e.preventDefault(); baseDrop.classList.add('drag-over'); });
  baseDrop.addEventListener('dragleave', () => baseDrop.classList.remove('drag-over'));
  baseDrop.addEventListener('drop', e => { e.preventDefault(); baseDrop.classList.remove('drag-over'); if (e.dataTransfer.files[0]) setBaseFile(e.dataTransfer.files[0]); });
  baseInput.addEventListener('change', e => { if (e.target.files[0]) setBaseFile(e.target.files[0]); baseInput.value = ''; });

  const hooksDrop = $('hooks-drop'), hooksInput = $('hooks-input');
  hooksDrop.addEventListener('click', () => hooksInput.click());
  hooksDrop.addEventListener('dragover', e => { e.preventDefault(); hooksDrop.classList.add('drag-over'); });
  hooksDrop.addEventListener('dragleave', () => hooksDrop.classList.remove('drag-over'));
  hooksDrop.addEventListener('drop', e => { e.preventDefault(); hooksDrop.classList.remove('drag-over'); if (e.dataTransfer.files.length) setHookFiles(e.dataTransfer.files); });
  hooksInput.addEventListener('change', e => { if (e.target.files.length) setHookFiles(e.target.files); hooksInput.value = ''; });

  $('stitch-btn').addEventListener('click', startStitch);
  document.querySelectorAll('.tab').forEach(btn => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));
});
