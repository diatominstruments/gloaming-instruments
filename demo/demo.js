/*
 * Demo consumer: a throwaway lookahead sequencer driving the library, plus
 * a control panel generated entirely from each module's param schema. The
 * sequencer here is illustration only; the real one belongs to the song
 * builder.
 */
const {
  MonoSynth, FMSynth, DrumSynth, ModalSynth, FormantSynth, PercSynth,
  Drive, Delay, Reverb, Tape, AutoWah, Orbit, Compressor, PingPong, DRUM, chain, parseNote, create,
  describe, matches, sanitizeParams,
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
  perc: [
    '--- --- --- --- --- --- --- --- --- --- --- --- G-3 --- D#3 C-3',
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
  const perc = new PercSynth(ctx, { ...PercSynth.presets.Tom, gain: 0.6 });
  const voice = new FormantSynth(ctx, { vowel: 1.5, vibrato: 8, gain: 0.35 });
  const drive = new Drive(ctx);
  const wah = new AutoWah(ctx, { cutoff: 180, depth: 3.5, mix: 0.6 });
  const delay = new Delay(ctx, { mix: 0.2 });
  const reverb = new Reverb(ctx, { size: 3, mix: 0.35 });
  const orbit = new Orbit(ctx, { rate: 0.15 });
  const tape = new Tape(ctx);
  const comp = new Compressor(ctx, { threshold: -18, ratio: 3, makeup: 3 });
  const pingPong = new PingPong(ctx, { time: 0.36, mix: 0.25 });

  chain(bass, drive, wah, delay, master);
  chain(bells, reverb, master);
  chain(mallets, orbit, reverb);
  chain(voice, pingPong, master);
  chain(drums, master);
  chain(perc, delay);
  chain(master, comp, tape, limiter);

  rig = { bass, bells, drums, perc, mallets, voice, drive, wah, delay, reverb, orbit, pingPong, comp, tape };
  const panels = document.getElementById('panels');
  for (const [name, module] of Object.entries(rig)) panels.append(panel(name, module));
}

// ---- sequencer ---------------------------------------------------------------

function scheduleStep(i, t) {
  const cells = (line) => line.split(' ');
  for (const track of ['bass', 'bells', 'mallets', 'voice', 'perc']) {
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

// ---- metadata-driven controls --------------------------------------------------
//
// Everything below comes from describe(): sections from groups, graphs from
// group roles, names and tooltips from labels, formatting from units, and
// the compact view from `primary`. Nothing here knows about any one module.

const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
};

function panel(name, module) {
  const info = describe(module.constructor);
  const refreshers = [];
  const refresh = () => refreshers.forEach((f) => f());

  const box = el('fieldset', { title: info.description });
  box.append(el('legend', {}, `${name} `, el('small', {}, info.label)));

  // Presets: sanitizeParams fills the params a preset leaves out with defaults.
  const presets = el('select', { className: 'preset' }, new Option('preset…', ''));
  for (const preset of Object.keys(info.presets)) presets.add(new Option(preset, preset));
  presets.oninput = () => {
    if (!presets.value) return;
    const params = sanitizeParams(module.constructor, info.presets[presets.value]);
    for (const [param, value] of Object.entries(params)) module.setParam(param, value);
    refresh();
  };
  box.append(presets);

  for (const group of info.groups) {
    const section = el('div', { className: 'group' }, el('h3', {}, group.label));
    const graph = roleGraph(group, module);
    if (graph) {
      section.append(graph.node);
      refreshers.push(graph.draw);
    }
    for (const param of group.params) {
      const spec = info.params[param];
      const { row, update } = control(module, param, spec, refresh);
      section.append(row);
      refreshers.push(update);
      // Params that only matter in some modes dim when they don't.
      if (spec.activeWhen) refreshers.push(() => row.classList.toggle('inactive', !matches(spec.activeWhen, module.params)));
    }
    box.append(section);
  }

  // Round-trip through the song format, to show what a song would store.
  const save = el('button', { textContent: 'Copy JSON' });
  save.onclick = () => {
    const json = JSON.stringify(module.toJSON());
    navigator.clipboard?.writeText(json);
    console.log(json, create(ctx, JSON.parse(json)));   // proves it rebuilds
  };
  box.append(save);
  refresh();
  return box;
}

function control(module, param, spec, refresh) {
  const out = el('output');
  const row = el('label', { title: spec.description, className: spec.primary ? 'primary' : '' });
  let input, update;

  if (spec.type === 'choice') {
    input = el('select');
    for (const v of spec.values) input.add(new Option(spec.labels?.[v] ?? v, v));
    input.oninput = () => { module.setParam(param, input.value); refresh(); };
    update = () => { input.value = module.params[param]; };
  } else {
    // Sliders run 0..1000 and map through the schema's scale hint.
    const log = spec.scale === 'log';
    const toValue = (x) => (log ? spec.min * (spec.max / spec.min) ** x : spec.min + (spec.max - spec.min) * x);
    const toSlider = (v) => (log ? Math.log(v / spec.min) / Math.log(spec.max / spec.min) : (v - spec.min) / (spec.max - spec.min));
    input = el('input', { type: 'range', min: 0, max: 1000 });
    if (spec.marks) {
      // Named points become tick marks on the slider.
      const list = el('datalist', { id: `marks-${Math.random().toString(36).slice(2)}` });
      for (const m of spec.marks) list.append(new Option(m.label, toSlider(m.value) * 1000));
      row.append(list);
      input.setAttribute('list', list.id);
    }
    input.oninput = () => { module.setParam(param, toValue(input.value / 1000)); refresh(); };
    update = () => {
      input.value = toSlider(module.params[param]) * 1000;
      out.textContent = fmt(module.params[param], spec);
    };
  }
  row.prepend(el('span', { textContent: spec.label }));
  row.append(input, out);
  return { row, update };
}

/** Units to text: seconds under 1 in ms, Hz over 1000 in kHz, fractions as %. */
function fmt(v, spec) {
  const near = spec.marks?.reduce((a, b) => (Math.abs(b.value - v) < Math.abs(a.value - v) ? b : a));
  if (near) return Math.abs(near.value - v) < 0.05 ? near.label : `${num3(v)} ≈${near.label}`;
  const sign = spec.center != null && v > spec.center ? '+' : '';
  switch (spec.unit) {
    case 's': return v < 1 ? `${num3(v * 1000)} ms` : `${num3(v)} s`;
    case 'Hz': return v >= 1000 ? `${num3(v / 1000)} kHz` : `${num3(v)} Hz`;
    case '%': return `${Math.round(v * 100)}%`;
    case '×': return `×${num3(v)}`;
    case ':1': return `${num3(v)}:1`;
    case undefined: return sign + num3(v);
    default: return `${sign}${num3(v)} ${spec.unit}`;
  }
}

const num3 = (v) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2));

// ---- role graphs ----------------------------------------------------------------
//
// A group's role says what it is; its bind maps the role's slots to params
// (or fixed { value }s), so the same drawing code serves every module.

function roleGraph(group, module) {
  const draw = { envelope: drawEnvelope, filter: drawFilter, dynamics: drawDynamics }[group.role];
  if (!draw) return null;
  const slot = (name) => {
    const b = group.bind[name];
    return typeof b === 'string' ? module.params[b] : b?.value;
  };
  const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  node.setAttribute('viewBox', '0 0 200 40');
  node.setAttribute('preserveAspectRatio', 'none');
  node.classList.add('graph');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  node.append(path);
  return { node, draw: () => path.setAttribute('d', draw(slot)) };
}

// Stage widths on a square-root scale, so 2 ms and 2 s both stay visible.
function drawEnvelope(slot) {
  const w = (t) => Math.sqrt(t ?? 0);
  const a = w(slot('attack'));
  const d = w(slot('decay'));
  const r = w(slot('release'));
  const s = slot('sustain') ?? (slot('decay') == null ? 1 : 0);
  const hold = slot('release') == null ? 0 : 0.6;
  const scale = 200 / (a + d + hold + r || 1);
  const y = (level) => 38 - level * 36;
  const pts = [[0, 0], [a, 1], [a + d, s], [a + d + hold, s], [a + d + hold + r, 0]];
  return 'M' + pts.map(([x, l]) => `${(x * scale).toFixed(1)},${y(l).toFixed(1)}`).join(' L');
}

// The browser's own biquad math, on a filter that's never connected.
const FREQS = Float32Array.from({ length: 100 }, (_, i) => 20 * 1000 ** (i / 99));
function drawFilter(slot) {
  const biquad = new BiquadFilterNode(ctx, { type: slot('type'), frequency: slot('cutoff'), Q: slot('resonance') });
  const mag = new Float32Array(FREQS.length);
  biquad.getFrequencyResponse(FREQS, mag, new Float32Array(FREQS.length));
  const y = (m) => Math.min(39, Math.max(1, 20 - (20 * Math.log10(m || 1e-6)) * 0.6));
  return 'M' + [...mag].map((m, i) => `${(i * 200 / 99).toFixed(1)},${y(m).toFixed(1)}`).join(' L');
}

// Output level against input level, -60..0 dB. The knee eases the slope
// from 1 down to 1/ratio between the threshold and threshold + knee.
function drawDynamics(slot) {
  const [t, r, k] = [slot('threshold'), slot('ratio'), slot('knee')];
  const out = (x) => {
    if (x < t) return x;
    if (x < t + k) return x + ((1 / r - 1) * (x - t) ** 2) / (2 * k);
    return t + (k * (1 + 1 / r)) / 2 + (x - t - k) / r;
  };
  const pts = Array.from({ length: 61 }, (_, i) => i - 60);
  return 'M' + pts.map((x) => `${((x + 60) * 200 / 60).toFixed(1)},${(-out(x) * 40 / 60).toFixed(1)}`).join(' L');
}

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
document.getElementById('compact').oninput = (e) => document.body.classList.toggle('compact', e.target.checked);
