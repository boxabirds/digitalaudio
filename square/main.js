const TOTAL_PARTIALS = 64;
const BASE_FREQUENCY = 220;
const SAMPLE_POINTS = 1024;
const TWO_PI = Math.PI * 2;

const startButton = document.getElementById('start-audio');
const playButton = document.getElementById('toggle-play');
const masterGainSlider = document.getElementById('master-gain');
const defaultsButton = document.getElementById('apply-square-defaults');
const resetButton = document.getElementById('reset-fundamental');
const builderButton = document.getElementById('square-builder-start');
const builderStepInput = document.getElementById('square-step-duration');
const builderCountInput = document.getElementById('square-odd-count');
const partialsContainer = document.getElementById('partials-list');
const sumCanvas = document.getElementById('sum-canvas');
const sumCtx = sumCanvas.getContext('2d');

let audioCtx;
let masterGain;
let outputGate;
let isPlaying = false;
let squareBuilderTimer = null;
let squareBuilderActive = false;
let squareBuilderIndex = 0;
let squareBuilderSequence = [];

const partials = [];
const idealSquare = new Float32Array(SAMPLE_POINTS);
for (let i = 0; i < SAMPLE_POINTS; i += 1) {
  const t = i / SAMPLE_POINTS;
  const s = Math.sin(TWO_PI * t);
  idealSquare[i] = s >= 0 ? 1 : -1;
}

function resizeCanvas(canvas, ctx) {
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth || canvas.width;
  const height = canvas.clientHeight || canvas.height;
  const displayWidth = Math.max(1, Math.floor(width * dpr));
  const displayHeight = Math.max(1, Math.floor(height * dpr));

  if (canvas.width !== displayWidth || canvas.height !== displayHeight) {
    canvas.width = displayWidth;
    canvas.height = displayHeight;
  }

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.scale(dpr, dpr);
  return { width: width || canvas.width / dpr, height: height || canvas.height / dpr };
}

function formatAmplitude(value) {
  return Number.parseFloat(value).toFixed(3);
}

function setPartialState(partial, amplitude, enabled) {
  partial.amplitude = amplitude;
  partial.enabled = enabled;
  partial.dom.amplitudeSlider.value = amplitude.toFixed(3);
  partial.dom.amplitudeValue.textContent = formatAmplitude(amplitude);
  partial.dom.includeToggle.checked = enabled;
  updatePartialGain(partial);
}

function createPartialRow(index) {
  const harmonic = index + 1;
  const frequency = BASE_FREQUENCY * harmonic;
  const defaultAmplitude = harmonic % 2 === 1 ? 4 / (Math.PI * harmonic) : 0;
  const enabled = defaultAmplitude > 0;

  const partial = {
    harmonic,
    frequency,
    defaultAmplitude,
    amplitude: defaultAmplitude,
    enabled,
    oscillator: null,
    gainNode: null,
    dom: {},
  };

  const wrapper = document.createElement('div');
  wrapper.className = 'partial';

  const info = document.createElement('div');
  info.className = 'partial-info';

  const title = document.createElement('h3');
  title.textContent = `Harmonic ${harmonic}`;

  const freqLabel = document.createElement('span');
  const multiplier = harmonic === 1 ? '1×' : `${harmonic}×`;
  freqLabel.textContent = `${frequency.toFixed(0)} Hz (${multiplier} fundamental)`;

  info.appendChild(title);
  info.appendChild(freqLabel);

  const controls = document.createElement('div');
  controls.className = 'partial-controls';

  const amplitudeLabel = document.createElement('label');
  amplitudeLabel.textContent = 'Amplitude';

  const amplitudeSlider = document.createElement('input');
  amplitudeSlider.type = 'range';
  amplitudeSlider.min = '0';
  amplitudeSlider.max = '1.5';
  amplitudeSlider.step = '0.01';
  amplitudeSlider.value = defaultAmplitude.toFixed(3);
  amplitudeLabel.appendChild(amplitudeSlider);

  const amplitudeValue = document.createElement('span');
  amplitudeValue.className = 'partial-amp-value';
  amplitudeValue.textContent = formatAmplitude(defaultAmplitude);
  amplitudeLabel.appendChild(amplitudeValue);

  const includeLabel = document.createElement('label');
  includeLabel.textContent = 'Include';

  const includeToggle = document.createElement('input');
  includeToggle.type = 'checkbox';
  includeToggle.checked = enabled;
  includeLabel.prepend(includeToggle);

  controls.appendChild(amplitudeLabel);
  controls.appendChild(includeLabel);

  const canvas = document.createElement('canvas');
  canvas.className = 'partial-canvas';
  canvas.height = 80;
  const canvasCtx = canvas.getContext('2d');

  wrapper.appendChild(info);
  wrapper.appendChild(controls);
  wrapper.appendChild(canvas);

  partial.dom.wrapper = wrapper;
  partial.dom.amplitudeSlider = amplitudeSlider;
  partial.dom.amplitudeValue = amplitudeValue;
  partial.dom.includeToggle = includeToggle;
  partial.dom.canvas = canvas;
  partial.dom.canvasCtx = canvasCtx;

  amplitudeSlider.addEventListener('input', () => {
    stopSquareBuilderAnimation();
    const value = Number.parseFloat(amplitudeSlider.value);
    if (Number.isNaN(value)) {
      return;
    }
    setPartialState(partial, value, partial.enabled);
  });

  includeToggle.addEventListener('change', () => {
    stopSquareBuilderAnimation();
    partial.enabled = includeToggle.checked;
    updatePartialGain(partial);
  });

  partialsContainer.appendChild(wrapper);
  partials.push(partial);
  resizeCanvas(canvas, canvasCtx);
}

function updatePartialGain(partial) {
  if (!partial.gainNode || !audioCtx) {
    return;
  }
  const targetGain = partial.enabled ? partial.amplitude : 0;
  partial.gainNode.gain.setTargetAtTime(targetGain, audioCtx.currentTime, 0.03);
}

function setupAudioGraph() {
  if (audioCtx) {
    return;
  }

  audioCtx = new AudioContext();
  masterGain = audioCtx.createGain();
  masterGain.gain.value = Number.parseFloat(masterGainSlider.value);

  outputGate = audioCtx.createGain();
  outputGate.gain.value = 0;

  masterGain.connect(outputGate).connect(audioCtx.destination);

  partials.forEach((partial) => {
    const oscillator = audioCtx.createOscillator();
    oscillator.type = 'sine';
    oscillator.frequency.value = partial.frequency;

    const gainNode = audioCtx.createGain();
    gainNode.gain.value = partial.enabled ? partial.amplitude : 0;

    oscillator.connect(gainNode).connect(masterGain);
    oscillator.start();

    partial.oscillator = oscillator;
    partial.gainNode = gainNode;
  });
}

function computeCompositeWave() {
  const values = new Float32Array(SAMPLE_POINTS);
  let maxMagnitude = 0;

  for (let i = 0; i < SAMPLE_POINTS; i += 1) {
    const t = i / SAMPLE_POINTS;
    let sampleValue = 0;

    for (const partial of partials) {
      if (!partial.enabled || partial.amplitude === 0) {
        continue;
      }
      sampleValue += partial.amplitude * Math.sin(TWO_PI * partial.harmonic * t);
    }

    values[i] = sampleValue;
    maxMagnitude = Math.max(maxMagnitude, Math.abs(sampleValue));
  }

  return { values, maxMagnitude };
}

function drawComposite(sumData) {
  const { width, height } = resizeCanvas(sumCanvas, sumCtx);
  const verticalCenter = height / 2;
  const scaleAmplitude = Math.max(1, sumData.maxMagnitude);
  const verticalPadding = height * 0.1;
  const availableHeight = verticalCenter - verticalPadding;
  const verticalScale = availableHeight / scaleAmplitude;

  sumCtx.clearRect(0, 0, width, height);

  // Mid-line
  sumCtx.strokeStyle = 'rgba(148, 163, 184, 0.25)';
  sumCtx.lineWidth = 1;
  sumCtx.setLineDash([4, 6]);
  sumCtx.beginPath();
  sumCtx.moveTo(0, verticalCenter);
  sumCtx.lineTo(width, verticalCenter);
  sumCtx.stroke();
  sumCtx.setLineDash([]);

  sumCtx.lineWidth = 2.4;
  sumCtx.strokeStyle = '#f97316';
  sumCtx.beginPath();
  for (let i = 0; i < idealSquare.length; i += 1) {
    const x = (i / (idealSquare.length - 1)) * width;
    const y = verticalCenter - idealSquare[i] * verticalScale;
    if (i === 0) {
      sumCtx.moveTo(x, y);
    } else {
      sumCtx.lineTo(x, y);
    }
  }
  sumCtx.stroke();

  sumCtx.lineWidth = 3;
  sumCtx.strokeStyle = '#38bdf8';
  sumCtx.beginPath();
  for (let i = 0; i < sumData.values.length; i += 1) {
    const x = (i / (sumData.values.length - 1)) * width;
    const y = verticalCenter - sumData.values[i] * verticalScale;
    if (i === 0) {
      sumCtx.moveTo(x, y);
    } else {
      sumCtx.lineTo(x, y);
    }
  }
  sumCtx.stroke();
}

function drawPartial(partial) {
  const canvas = partial.dom.canvas;
  const ctx = partial.dom.canvasCtx;
  const { width, height } = resizeCanvas(canvas, ctx);
  const verticalCenter = height / 2;
  const amplitude = partial.enabled ? partial.amplitude : 0;
  const scaleAmplitude = Math.max(1, amplitude);
  const verticalScale = (height * 0.4) / scaleAmplitude;

  ctx.clearRect(0, 0, width, height);
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.25)';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 6]);
  ctx.beginPath();
  ctx.moveTo(0, verticalCenter);
  ctx.lineTo(width, verticalCenter);
  ctx.stroke();
  ctx.setLineDash([]);

  if (amplitude === 0) {
    return;
  }

  ctx.strokeStyle = partial.enabled ? '#38bdf8' : 'rgba(56, 189, 248, 0.25)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let i = 0; i < SAMPLE_POINTS; i += 1) {
    const t = i / SAMPLE_POINTS;
    const value = amplitude * Math.sin(TWO_PI * partial.harmonic * t);
    const x = (i / (SAMPLE_POINTS - 1)) * width;
    const y = verticalCenter - value * verticalScale;
    if (i === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  }
  ctx.stroke();
}

function render() {
  const sumData = computeCompositeWave();
  drawComposite(sumData);
  for (const partial of partials) {
    drawPartial(partial);
  }
  requestAnimationFrame(render);
}

async function togglePlayback() {
  if (!audioCtx) {
    return;
  }

  if (!isPlaying) {
    await audioCtx.resume();
    outputGate.gain.setTargetAtTime(1, audioCtx.currentTime, 0.02);
    playButton.textContent = 'Pause';
    isPlaying = true;
  } else {
    outputGate.gain.setTargetAtTime(0, audioCtx.currentTime, 0.02);
    playButton.textContent = 'Play';
    isPlaying = false;
  }
}

function applySquareDefaults() {
  stopSquareBuilderAnimation();
  partials.forEach((partial) => {
    const isOdd = partial.harmonic % 2 === 1;
    const defaultAmplitude = isOdd ? partial.defaultAmplitude : 0;
    setPartialState(partial, defaultAmplitude, isOdd);
  });
}

function resetToFundamental() {
  stopSquareBuilderAnimation();
  partials.forEach((partial) => {
    if (partial.harmonic === 1) {
      setPartialState(partial, 1, true);
    } else {
      setPartialState(partial, 0, false);
    }
  });
}

function stopSquareBuilderAnimation() {
  if (squareBuilderTimer) {
    clearTimeout(squareBuilderTimer);
    squareBuilderTimer = null;
  }
  if (!squareBuilderActive) {
    return;
  }
  squareBuilderActive = false;
  squareBuilderIndex = 0;
  squareBuilderSequence = [];
  if (builderButton) {
    builderButton.textContent = 'Animate Square Build';
  }
}

function startSquareBuilderAnimation() {
  stopSquareBuilderAnimation();

  const stepSeconds = Math.max(0.1, Number.parseFloat(builderStepInput.value) || 1);
  const maxOddsRaw = Number.parseInt(builderCountInput.value, 10);
  const maxOddsCap = Math.ceil(TOTAL_PARTIALS / 2);
  const oddCount = Math.max(1, Math.min(maxOddsRaw || 32, maxOddsCap));

  builderStepInput.value = stepSeconds.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  builderCountInput.value = oddCount;

  const harmonics = [];
  let harmonic = 1;
  while (harmonics.length < oddCount && harmonic <= TOTAL_PARTIALS) {
    harmonics.push(harmonic);
    harmonic += 2;
  }

  partials.forEach((partial) => {
    setPartialState(partial, 0, false);
  });

  squareBuilderSequence = harmonics;
  squareBuilderIndex = 0;
  squareBuilderActive = true;
  builderButton.textContent = 'Stop Animation';

  const stepMs = stepSeconds * 1000;

  const runStep = () => {
    if (!squareBuilderActive || squareBuilderIndex >= squareBuilderSequence.length) {
      stopSquareBuilderAnimation();
      return;
    }

    const nextHarmonic = squareBuilderSequence[squareBuilderIndex];
    const partial = partials[nextHarmonic - 1];
    const amplitude = partial.defaultAmplitude || 0;

    setPartialState(partial, amplitude, true);

    squareBuilderIndex += 1;

    if (squareBuilderIndex >= squareBuilderSequence.length) {
      stopSquareBuilderAnimation();
      return;
    }

    squareBuilderTimer = setTimeout(runStep, stepMs);
  };

  runStep();
}

masterGainSlider.addEventListener('input', () => {
  if (!masterGain || !audioCtx) {
    return;
  }
  masterGain.gain.setTargetAtTime(Number.parseFloat(masterGainSlider.value), audioCtx.currentTime, 0.02);
});

startButton.addEventListener('click', async () => {
  if (!audioCtx) {
    setupAudioGraph();
    await audioCtx.resume();
    startButton.disabled = true;
    startButton.textContent = 'Audio ready';
    playButton.disabled = false;
    defaultsButton.disabled = false;
    resetButton.disabled = false;
    builderButton.disabled = false;
  }
});

playButton.addEventListener('click', () => {
  togglePlayback();
});

defaultsButton.addEventListener('click', () => {
  applySquareDefaults();
});

resetButton.addEventListener('click', () => {
  resetToFundamental();
});

builderButton.addEventListener('click', () => {
  if (squareBuilderActive) {
    stopSquareBuilderAnimation();
  } else {
    startSquareBuilderAnimation();
  }
});

builderStepInput.addEventListener('change', () => {
  if (!squareBuilderActive) {
    return;
  }
  startSquareBuilderAnimation();
});

builderCountInput.addEventListener('change', () => {
  if (!squareBuilderActive) {
    return;
  }
  startSquareBuilderAnimation();
});

window.addEventListener('resize', () => {
  resizeCanvas(sumCanvas, sumCtx);
  partials.forEach((partial) => {
    resizeCanvas(partial.dom.canvas, partial.dom.canvasCtx);
  });
});

for (let i = 0; i < TOTAL_PARTIALS; i += 1) {
  createPartialRow(i);
}

defaultsButton.disabled = false;
resetButton.disabled = false;
builderButton.disabled = false;
render();
