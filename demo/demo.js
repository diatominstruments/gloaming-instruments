/*
 * Demo consumer: a throwaway lookahead sequencer driving the library, plus
 * a control panel generated entirely from each module's param schema. The
 * sequencer here is illustration only; the real one belongs to the song
 * builder.
 */
const {
  MonoSynth, FMSynth, DrumSynth, ModalSynth, FormantSynth,
  Drive, Delay, Reverb, Tape, AutoWah, Orbit, DRUM, chain, parseNote, create,
} = gloamingInstruments;

const STEPS = 16;
const LOOKAHEAD = 0.1;   // seconds of audio scheduled ahead
const TICK_MS = 25;

// Melodic lines: space-separated tracker cells. '---' holds, '===' releases,
// and a trailing '/' slides into the note (noteOn before the old noteOff).
// Drum lines: one character per step, 'x' full hit, 'o' ghost.
const PATTERN = {
  bass: [
    'C-2 C-3 C-2 --- D#2 === C-2 G-2/ C-2 C-3 --- A#2/ C-2 === F-2 G-2',
  ],
  bells: [
    'G-5 --- --- --- --- --- --- --- D#5 --- --- --- --- --- --- ===',
    'C-5 --- --- --- --- --- --- --- A#4 --- --- --- --- --- --- ===',
  ],
  mallets: [
    '--- --- C-6 --- --- --- G-5 --- --- --- D#6 --- --- G-6 --- ---',
  ],
  voice: [
    'C-3 --- --- --- --- --- --- === A#2 --- --- --- --- --- --- ===',
    'G-3 --- --- --- --- --- --- === F-3 --- --- --- --- --- --- ===',
    'D#4 --- --- --- --- --- --- === D-4 --- --- --- --- --- --- ===',
  ],
  drums: {
    [DRUM.KICK]:       'x...x...x...x..o',
    [DRUM.SNARE]:      '....x.......x...',
    [DRUM.CLAP]:       '............x...',
    [DRUM.CLOSED_HAT]: 'x.o.x.o.x.o.x.oo',
    [DRUM.OPEN_HAT]:   '..x...x...x...x.',
  },
};

let ctx, master, scope, rig, timer, nextTime, step;
const lineState = new Map();   // melodic line -> note currently sounding

function buildRig() {
  ctx = new AudioContext();
  master = new GainNode(ctx, { gain: 0.8 });
  const limiter = new DynamicsCompressorNode(ctx, { threshold: -6, ratio: 20, attack: 0.002, release: 0.1 });
  scope = new AnalyserNode(ctx, { fftSize: 2048 });
  limiter.connect(scope).connect(ctx.destination);

  const bass = new MonoSynth(ctx);
  const bells = new FMSynth(ctx);
  const drums = new DrumSynth(ctx);
  const mallets = new ModalSynth(ctx, { gain: 0.4 });
  const voice = new FormantSynth(ctx, { vowel: 1.5, vibrato: 8, gain: 0.35 });
  const drive = new Drive(ctx);
  const wah = new AutoWah(ctx, { cutoff: 180, depth: 3.5, mix: 0.6 });
  const delay = new Delay(ctx, { mix: 0.2 });
  const reverb = new Reverb(ctx, { size: 3, mix: 0.35 });
  const orbit = new Orbit(ctx, { rate: 0.15 });
  const tape = new Tape(ctx);

  chain(bass, drive, wah, delay, master);
  chain(bells, reverb, master);
  chain(mallets, orbit, reverb);
  chain(voice, master);
  chain(drums, master);
  chain(master, tape, limiter);

  rig = { bass, bells, drums, mallets, voice, drive, wah, delay, reverb, orbit, tape };
  const panels = document.getElementById('panels');
  for (const [name, module] of Object.entries(rig)) panels.append(panel(name, module));
}

// ---- sequencer ---------------------------------------------------------------

function scheduleStep(i, t) {
  const cells = (line) => line.split(' ');
  for (const track of ['bass', 'bells', 'mallets', 'voice']) {
    const lines = PATTERN[track];
    const inst = rig[track];
    for (const line of lines) {
      const cell = cells(line)[i];
      const prev = lineState.get(line);
      if (cell === '===' && prev != null) {
        inst.noteOff(prev, t);
        lineState.delete(line);
        continue;
      }
      const note = parseNote(cell.replace('/', ''));
      if (note == null) continue;
      const slide = cell.endsWith('/');
      if (prev != null && !slide) inst.noteOff(prev, t);
      inst.noteOn(note, 0.9, t);
      if (prev != null && slide && prev !== note) inst.noteOff(prev, t);
      lineState.set(line, note);
    }
  }
  for (const [note, line] of Object.entries(PATTERN.drums)) {
    const c = line[i];
    if (c === 'x') rig.drums.noteOn(Number(note), 1, t);
    else if (c === 'o') rig.drums.noteOn(Number(note), 0.45, t);
  }
}

function tick() {
  const stepLength = 60 / Number(document.getElementById('bpm').value) / 4;
  while (nextTime < ctx.currentTime + LOOKAHEAD) {
    scheduleStep(step, nextTime);
    highlight(step, nextTime);
    nextTime += stepLength;
    step = (step + 1) % STEPS;
  }
}

async function start() {
  if (!ctx) buildRig();
  await ctx.resume();
  step = 0;
  nextTime = ctx.currentTime + 0.05;
  timer = setInterval(tick, TICK_MS);
  tick();
}

function stop() {
  clearInterval(timer);
  timer = null;
  const now = ctx.currentTime;
  for (const m of Object.values(rig)) m.allNotesOff?.(now);
  lineState.clear();
}

// ---- schema-driven controls ----------------------------------------------------

function panel(name, module) {
  const box = document.createElement('fieldset');
  box.innerHTML = `<legend>${name} <small>${module.constructor.id}</small></legend>`;

  for (const [param, spec] of Object.entries(module.constructor.params)) {
    const row = document.createElement('label');
    const out = document.createElement('output');
    let input;

    if (spec.type === 'choice') {
      input = document.createElement('select');
      for (const v of spec.values) input.add(new Option(v, v, false, v === module.params[param]));
      input.oninput = () => module.setParam(param, input.value);
    } else {
      // Sliders run 0..1000 and map through the schema's scale hint.
      const log = spec.scale === 'log';
      const toValue = (x) => (log ? spec.min * (spec.max / spec.min) ** x : spec.min + (spec.max - spec.min) * x);
      const toSlider = (v) => (log ? Math.log(v / spec.min) / Math.log(spec.max / spec.min) : (v - spec.min) / (spec.max - spec.min));
      input = Object.assign(document.createElement('input'), { type: 'range', min: 0, max: 1000 });
      input.value = toSlider(module.params[param]) * 1000;
      const show = () => { out.textContent = fmt(module.params[param], spec.unit); };
      input.oninput = () => { module.setParam(param, toValue(input.value / 1000)); show(); };
      show();
    }
    row.append(Object.assign(document.createElement('span'), { textContent: param }), input, out);
    box.append(row);
  }

  // Round-trip through the song format, to show what a song would store.
  const save = Object.assign(document.createElement('button'), { textContent: 'Copy JSON' });
  save.onclick = () => {
    const json = JSON.stringify(module.toJSON());
    navigator.clipboard?.writeText(json);
    console.log(json, create(ctx, JSON.parse(json)));   // proves it rebuilds
  };
  box.append(save);
  return box;
}

const fmt = (v, unit = '') => {
  const s = Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(3);
  return unit ? `${s} ${unit}` : s;
};

// ---- display ----------------------------------------------------------------

const lights = [];
function buildLights() {
  const row = document.getElementById('steps');
  for (let i = 0; i < STEPS; i++) row.append(lights[i] = document.createElement('i'));
}

function highlight(i, t) {
  // Visuals follow the audio clock, not the scheduler, which runs ahead.
  setTimeout(() => lights.forEach((l, k) => l.classList.toggle('on', k === i)),
    Math.max(0, (t - ctx.currentTime) * 1000));
}

function drawScope() {
  const canvas = document.getElementById('scope');
  const g = canvas.getContext('2d');
  const data = new Uint8Array(2048);
  const frame = () => {
    requestAnimationFrame(frame);
    g.clearRect(0, 0, canvas.width, canvas.height);
    if (!scope) return;
    scope.getByteTimeDomainData(data);
    g.strokeStyle = getComputedStyle(canvas).color;
    g.lineWidth = 2;
    g.beginPath();
    for (let i = 0; i < data.length; i++) {
      const x = (i / data.length) * canvas.width;
      const y = (data[i] / 255) * canvas.height;
      i ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.stroke();
  };
  frame();
}

buildLights();
drawScope();
document.getElementById('play').onclick = () => (timer ? stop() : start());
