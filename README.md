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
| `static sidechain`, `sidechain` | effects only: a second audio input, if the effect has one (below) |
| `params` | current values |
| `setParam(name, value, time)` | clamped to the schema |
| `toJSON()` / `create(ctx, json)` | `{ id, version, params }`, the form a song stores |
| `ready` | promise; resolves once samples load |
| `dispose()` | |

Events must arrive in time order, which any sequencer does naturally.

### Sidechains

An effect driven by a second sound declares `static sidechain`, and each
instance has a `sidechain` GainNode for the app to connect that sound to:

```js
const duck = new Compressor(ctx, Compressor.presets.Duck);
chain(pad, duck, ctx.destination);
drums.output.connect(duck.sidechain);   // the kick ducks the pad
```

The declaration carries a `label`, a `description` and an `activeWhen`
(the param values under which the sidechain is heard), so an app can offer
a source picker only when it matters. `describe()` gives it as `sidechain`
on every effect, `null` for those without one. Which track feeds a
sidechain is routing, like the order of a chain, so the app stores it;
the module's params only say whether to listen.

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
| `unit` | one of `UNITS`: `Hz s dB st ct oct m % × :1 note`; `%` values are 0..1 fractions, `:1` a ratio, `note` a MIDI note number to show as a name |
| `labels` | choices: display names for the stored values |
| `catalog` | choices: the values are a growing library (sample banks), so offer a menu or list rather than buttons |
| `categories` | choices: a heading per value, `{ value: heading }`, for sectioning a long list |
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
| `mono-synth` | instrument | two oscs (saw, square, pulse with PWM, …) + sub (1 or 2 oct down) + noise → key-tracked resonant lowpass with decay env; LFO (triangle, square, ramp, sample-and-hold; free or note-synced, with fade-in) for vibrato, filter and PWM; last-note priority with glide (overlap notes to slide); warm character: curved saws, pitch drift, 24 dB filter with soft saturation |
| `fm-synth` | instrument | 4-op FM, 8 voices, an envelope per operator; eight algorithms (stacks, forks, pairs, additive) in `FM_ALGORITHMS` as `[from, to]` pairs for drawing the routing |
| `drum-synth` | instrument | synthesized kick, snare, clap, closed/open hat (choked); notes in `DRUM` |
| `sampler` | instrument | plays one of the bundled `SAMPLE_BANKS` (see below): a kit, one sound per key, or a pitched bank across the keyboard; one-shot or gated, with choke groups |
| `modal-synth` | instrument | struck or bowed bars, bowls, bells and drums: a high-Q bandpass bank per note, rung by a noise burst or a steady bow; wood, glass, steel, bell, membrane and tine mode tables, with stretch, strike position, warble, pitch drop and humanise |
| `formant-synth` | instrument | 1–6 detuned oscillators per note plus breath noise, through a tone lowpass and four vowel formants; sweep `vowel` from a to u to make it talk, or let each note glide in from `vowelStart` and an LFO move it; formant `shift` for bigger or smaller throats; poly or mono with glide |
| `poly-synth` | instrument | 6-voice analog-style poly: saw, pulse (PWM from a saw minus its delayed self), sub and noise → 24 dB resonant lowpass with one ADSR on filter and amp; shared LFO with fade-in; switchable highpass and built-in chorus modes I / II / I+II |
| `cumulus-poly` | instrument | 8-voice Oberheim-style poly: two oscillators (saw, pulse, triangle; detune, interval, cross-mod) plus sub and noise, per-voice drive, 12 or 24 dB multimode filter, separate filter and amp ADSRs, seeded per-voice drift; `mode` 'supersaw' makes osc 1 a JP-8000-style stack of seven detuned saws, spread in stereo and highpassed so the low end stays mono |
| `chip-synth` | instrument | 8-bit console channels: pulse at 12.5/25/50%, the 32-step 4-bit triangle, and 15-bit shift-register noise (long hiss, short metallic buzz), all built exactly; tracker-style fast arpeggios through a chord (a looped buffer of intervals on the pitch, sample-exact), pitch sweeps, delayed vibrato, and a volume envelope stepped to 16 levels; poly, or mono with glide |
| `texture-synth` | instrument | seeded noise, brown through pink to white and uncorrelated left and right, through a resonant filter per note that can track the pitch (wind chords, tuned whistles); a sweep per note for risers and downlifters; one random or sine motion LFO moving every note's cutoff and level, for gusts and waves |
| `perc-synth` | instrument | two oscillators cross-modulating each other's frequency, plus filtered noise; ADSR pitch envelope on osc 1, retriggered LFO sent to pitch, cross-mod, noise or amp; one-shot or gated |
| `filter` | effect | resonant biquad |
| `drive` | effect | tanh saturation + tone |
| `delay` | effect | feedback delay, darkening repeats |
| `reverb` | effect | convolution with a seeded, generated impulse |
| `aurora-reverb` | effect | algorithmic stereo reverb: allpass diffusion into eight modulated delay lines mixed by a Hadamard matrix, with per-line damping and exact decay times; shimmer pitch-shifts part of the tail on every pass (+5th, +1 oct, +1 oct 5th or −1 oct) so it climbs as it rings; freeze holds it indefinitely |
| `tape` | effect | wow and flutter, tanh saturation, head rolloff, seeded hiss |
| `auto-wah` | effect | resonant filter opened by an envelope follower built from a rectifying WaveShaper and a smoothing lowpass |
| `orbit` | effect | HRTF panner circling the listener on two LFOs; for headphones |
| `compressor` | effect | threshold/ratio/knee compression with makeup gain; `reduction` reads the current gain reduction for a meter; `detector` 'sidechain' takes the level from the sidechain instead, for ducking (DynamicsCompressorNode has no key input, so the key rides as a second channel beside the audio, held 80 dB down, and the node's linked detector does the rest) |
| `ping-pong` | effect | stereo delay, repeats alternating left and right, darkening as they go |
| `chorus` | effect | two delay lines swept in opposite directions by one triangle LFO, the classic modes in `CHORUS_MODES`; or `type` 'ensemble', three lines each swept by a slow and a fast sine a third of a cycle apart, panned left, centre and right, for string-machine blur |
| `resonator` | effect | a bank of high-Q bandpasses tuned to a chord on `root` (string, pipe, bar, glass or bell partials per note), rung by the input, so drums and noise come out pitched and in key; power-normalized per partial, soft-clipped so in-tune input can't run away |
| `phaser` | effect | 4–12 allpass stages per side swept by a sine LFO, the right side offset by `stereo`; no feedback (Web Audio loops cost a render quantum, which would comb), so `q` and stage count set the strength |
| `ring-mod` | effect | the input multiplied by a carrier (sine, triangle, square, saw), left and right detuned by `spread`, with an LFO sweeping the carrier's pitch |
| `vocoder` | effect | the input's spectrum, measured in 8–32 bands by envelope followers, imposed on a carrier: a built-in chord of detuned saws (`root`, `chord`), noise, or the sidechain (levelled on the way in, so a quiet track vocodes as loud as the chord); formant `shift`, band `width`, follower `response`, and `sibilance` passing the input's top end through |
| `lo-fi` | effect | bit crushing (sweepable, 1–12 bits), sample-rate fold-over imitated by gating with a square at `rate`, a bandwidth lowpass, and seeded vinyl crackle |

Anything random (noise, reverb impulses) is seeded, so a song renders the
same on every play and every machine.

## Sample banks

The sampler's sounds come from banks listed in
[src/instruments/sample-banks.js](src/instruments/sample-banks.js), each
keyed by its folder under `src/kits/`. A song stores only the `bank` param,
a choice like any other, so untrusted song data can pick a bank but can't
make the player fetch anything else. `describe(Sampler).banks` gives each
bank's label, type (`kit` or `pitched`) and keys, so an app can show a kit's
rows before its samples load.

A kit places its sounds on the fixed `KIT_SLOTS` (General MIDI drum notes),
and every slot has its own tune, release, direction, pan and level params
(`kickTune`, `kickRelease`, `kickReverse`, `kickPan`, `kickLevel`) in a
group whose `notes` name the slot. Release fades the hit out over its time
(at full, the whole sample plays); a reversed hit instead keeps only the
last `release` seconds of its swell. Each is
`activeWhen` the bank is a kit using that slot, so an app can hide the rest.
Pitched banks share the one `attack` / `release` envelope instead.

To add a bank, put its files in `src/kits/<key>/` and add an entry:

```js
808: {
  label: 'TR-808',
  type: 'kit',                     // or 'pitched', with zones { file, lo, hi, root }
  zones: [
    { file: 'BD.WAV', note: 36 },                 // a note from KIT_SLOTS
    { file: 'COW.WAV', note: 37, label: 'Cowbell' }, // any sound on any slot
    { file: 'CH.WAV', note: 42, choke: 'hat' },
    { file: 'OH.WAV', note: 46, choke: 'hat' },
  ],
},
```

`npm test` checks every file exists and each kit note is a slot used once.
Adding a slot to `KIT_SLOTS` adds params, so extend it rather than rename it. The build
copies the kits to `dist/kits/`. The library finds them beside itself, at
`src/kits/` as an ES module or `dist/kits/` as the bundle; set
`Sampler.bankRoot` if you serve them from somewhere else.

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
