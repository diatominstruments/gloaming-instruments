# gloaming-instruments

Web Audio instruments and effects behind one small, standard API: instruments
take sequencer input and produce audio, effects take audio and produce
modified audio. Companion to [GloamingKit](https://github.com/diatominstruments/gloaming-kit)
— run both on one `AudioContext` and the visualizations hear everything.

No runtime dependencies, and only standard Web Audio nodes (no worklets), so
everything also renders in an `OfflineAudioContext` for bouncing video.

## Building and running

```bash
npm install && npm run build
```

Writes `dist/gloaming-instruments.js`, an IIFE bundle exposing the API on a
`gloamingInstruments` global. `demo/index.html` needs to be served over http
(any static server from the repo root), then open `/demo/`.

## Using it

```js
import { MonoSynth, Drive, Delay, chain } from './src/index.js';

const ctx = new AudioContext();
const bass = new MonoSynth(ctx, { cutoff: 300, resonance: 18 });
chain(bass, new Drive(ctx), new Delay(ctx, { time: 0.36 }), ctx.destination);

const t = ctx.currentTime;
bass.noteOn(36, 1, t);               // MIDI note, velocity 0..1, context time
bass.noteOn(43, 1, t + 0.25);        // overlapping → slides
bass.noteOff(36, t + 0.25);
bass.noteOff(43, t + 0.5);
bass.setParam('cutoff', 1200, t + 0.5);
```

Every method takes an `AudioContext` time, so a sequencer can schedule
ahead of playback. Omitted or past times mean now.

## The API

**Instrument** — sound out on `.output`.

| method | |
|---|---|
| `noteOn(note, velocity, time)` | MIDI note number, velocity 0..1 |
| `noteOff(note, time)` | may be ignored (one-shot drums) |
| `allNotesOff(time)` | quick cut, for stop and seek |

**Effect** — sound in on `.input`, out on `.output`.

**Both** share:

| member | |
|---|---|
| `static id`, `static kind`, `static version` | identity; bump `version` when a change would alter how saved songs sound |
| `static params` | the param schema (below) |
| `params` | current values |
| `setParam(name, value, time)` | clamped to the schema |
| `toJSON()` / `create(ctx, json)` | `{ id, version, params }`, the form a song stores |
| `ready` | promise; resolves once samples load |
| `dispose()` | |

Events must arrive in time order, which any sequencer does naturally.

### Param schemas

```js
static params = {
  cutoff: num(30, 16000, 400, { unit: 'Hz', scale: 'log' }),
  wave:   choice(['sawtooth', 'square'], 'sawtooth'),
};
```

The schema is the whole contract. UIs generate their controls from it (the
demo builds every panel this way), and `create()` clamps untrusted song data
to it, so a shared song can't drive a module outside the ranges its author
tested. Params marked `automatable: false` (and all choices) rebuild or
switch something discretely; set them, but don't sweep them per row.

### Display metadata

On top of the schema, every module describes itself for UIs. None of it
affects the sound, and none of it says how to draw anything: it's
structure and meaning, for any app to present in its own way.
`describe(Module)` returns it all as plain JSON with defaults filled in,
and `manifest()` does the same for every registered module.

```js
static label = 'Mono Synth';
static description = 'One oscillator plus a sub through a resonant lowpass…';
static tags = ['bass', 'lead'];
static polyphony = 1;                 // instruments: null = no fixed limit
static gated = true;                  // does noteOff end a note? or { mode: 'gate' }

static params = {
  cutoff: num(30, 16000, 400, {
    unit: 'Hz', scale: 'log', primary: true,
    label: 'Cutoff', description: 'Filter frequency before the envelope opens it.',
  }),
  …
};

static groups = [
  { id: 'filter', label: 'Filter', params: ['cutoff', 'resonance'],
    role: 'filter', bind: { type: { value: 'lowpass' }, cutoff: 'cutoff', resonance: 'resonance' } },
  { id: 'amp', label: 'Amp envelope', params: ['attack', 'decay', 'sustain', 'release'],
    role: 'envelope', bind: { attack: 'attack', decay: 'decay', sustain: 'sustain', release: 'release' } },
  …
];

static presets = { 'Acid': { cutoff: 300, resonance: 18, envMod: 3.5 }, … };
```

| on a param | |
|---|---|
| `label`, `description` | display name (read under its group heading) and a sentence for tooltips |
| `unit` | one of `UNITS`: `Hz s dB st ct oct m % × :1`; `%` values are 0..1 fractions, `:1` a ratio |
| `labels` | choices: display names for the stored values |
| `marks` | named points on a range, `[{ value, label }]` (a formant synth's vowels) |
| `center` | where a control rests and fills from, for ranges straddling zero |
| `primary` | the two or three params to show when there's only room for a few |
| `activeWhen` | `{ mode: 'gate' }`: only has an effect while those choices are set |

| on a module | |
|---|---|
| `groups` | params as ordered sections; each param in exactly one |
| group `role` + `bind` | what a section *is*, so an app can draw an envelope or a filter curve instead of knobs; `bind` maps the role's slots to params or fixed `{ value }`s. Roles: `envelope` (attack, decay, sustain, release, amount), `filter` (type, cutoff, resonance), `dynamics` (threshold, ratio, knee) |
| group `notes` | for instruments with `keys`: the notes a section shapes (the kick's params) |
| `presets` | partial params; `sanitizeParams(M, M.presets[name])` gives the full set |
| `keys` | also on instances, since a sampler's depend on what it loaded |

`matches(condition, params)` evaluates `activeWhen` and `gated`.
`npm test` checks every module's metadata against its schema, so groups
and presets can't drift as params change. The demo builds its panels
from nothing but `describe()`.

## What's included

| id | kind | |
|---|---|---|
| `mono-synth` | instrument | osc + sub → resonant lowpass with decay env; last-note priority with glide (overlap notes to slide); warm character: curved saw, pitch drift, 24 dB filter with soft saturation |
| `fm-synth` | instrument | 4-op FM, 8 voices, an envelope per operator; eight algorithms (stacks, forks, pairs, additive) in `FM_ALGORITHMS` as `[from, to]` pairs for drawing the routing |
| `drum-synth` | instrument | synthesized kick, snare, clap, closed/open hat (choked); notes in `DRUM` |
| `sampler` | instrument | AudioBuffers across key zones; pitched or kit, one-shot or gated |
| `modal-synth` | instrument | struck bars, bowls and bells: a high-Q bandpass bank per note, rung by a noise burst; wood, glass, steel and bell mode tables |
| `formant-synth` | instrument | detuned sawtooths through four vowel formants; sweep `vowel` from a to u to make it talk |
| `perc-synth` | instrument | two oscillators cross-modulating each other's frequency, plus filtered noise; ADSR pitch envelope on osc 1, retriggered LFO sent to pitch, cross-mod, noise or amp; one-shot or gated |
| `filter` | effect | resonant biquad |
| `drive` | effect | tanh saturation + tone |
| `delay` | effect | feedback delay, darkening repeats |
| `reverb` | effect | convolution with a seeded, generated impulse |
| `tape` | effect | wow and flutter, tanh saturation, head rolloff, seeded hiss |
| `auto-wah` | effect | resonant filter opened by an envelope follower built from a rectifying WaveShaper and a smoothing lowpass |
| `orbit` | effect | HRTF panner circling the listener on two LFOs; for headphones |
| `compressor` | effect | threshold/ratio/knee compression with makeup gain; `reduction` reads the current gain reduction for a meter |
| `ping-pong` | effect | stereo delay, repeats alternating left and right, darkening as they go |

Anything random (noise, reverb impulses) is seeded, so a song renders the
same on every play and every machine.

## Writing your own

Extend `Instrument` or `Effect`, declare `id` and `params`, build your graph
from `this.params` in the constructor (the base class has already validated
them), and handle later changes in `applyParam(name, value, time)`. Params
read only at note-on need no `applyParam` at all. To rename or rescale
params without changing how old songs sound, translate the old names in
`static upgradeParams(params)`; it runs before validation. Then `register(MyThing)`
makes it loadable from song files. Display metadata is optional: without
it, labels come from param names and every param lands in one group.

```js
class Tremolo extends Effect {
  static id = 'tremolo';
  static params = { rate: num(0.1, 20, 5, { unit: 'Hz' }), depth: num(0, 1, 0.5) };

  constructor(ctx, params) {
    super(ctx, params);
    this.amp = new GainNode(ctx, { gain: 1 - this.params.depth / 2 });
    this.lfo = new OscillatorNode(ctx, { frequency: this.params.rate });
    this.depth = new GainNode(ctx, { gain: this.params.depth / 2 });
    this.lfo.connect(this.depth).connect(this.amp.gain);
    this.input.connect(this.amp).connect(this.output);
    this.lfo.start();
  }

  applyParam(name, value, time) {
    if (name === 'rate') this.lfo.frequency.setTargetAtTime(value, time, 0.01);
    if (name === 'depth') {
      this.depth.gain.setTargetAtTime(value / 2, time, 0.01);
      this.amp.gain.setTargetAtTime(1 - value / 2, time, 0.01);
    }
  }
}
register(Tremolo);
```
