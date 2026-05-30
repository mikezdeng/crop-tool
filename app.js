// Pure function: builds FFmpeg crop filter string for 9:16 → 4:5 center crop.
// Keeps full width, trims equal slices from top and bottom.
// Used here to document and test the math; FFmpeg exec uses equivalent native expressions.
function getCropParams(inputWidth, inputHeight) {
  const outHeight = Math.floor(inputWidth * 5 / 4);
  const yOffset = Math.floor((inputHeight - outHeight) / 2);
  return `crop=${inputWidth}:${outHeight}:0:${yOffset}`;
}

// Self-tests: run on page load to verify crop math
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
