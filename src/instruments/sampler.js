import { Instrument, num, choice } from '../module.js';
import { envStart, envRelease, noteName } from '../util.js';

/**
 * Sampler — plays AudioBuffers across key zones. One zone spanning the
 * keyboard gives a pitched instrument; one zone per note gives a drum kit.
 *
 *   await sampler.load([
 *     { sample: 'kits/909/kick.wav',  lo: 36, hi: 36, root: 36, label: 'Kick' },
 *     { sample: 'kits/909/snare.wav', lo: 38, hi: 38, root: 38, label: 'Snare' },
 *   ]);
 *   await sampler.load('pad.wav');   // shorthand: one zone, root C-4
 *
 * A zone plays its sample at original speed on `root` and repitches from
 * there. In 'one-shot' mode noteOff is ignored and each note chokes its own
 * previous hit (like a drum machine pad); in 'gate' mode notes release on
 * noteOff.
 *
 * Samples are assets rather than params: a zone given by URL is saved in
 * toJSON() and reloaded by fromJSON(); a zone given as a bare AudioBuffer
 * works but can't be saved.
 */
export class Sampler extends Instrument {
  static id = 'sampler';
  static label = 'Sampler';
  static description = 'Plays samples across key zones: one pitched across the keyboard, or one per key as a kit.';
  static tags = ['sampler'];
  static gated = { mode: 'gate' };
  static params = {
    mode: choice(['one-shot', 'gate'], 'one-shot', {
      label: 'Mode', description: 'One-shot plays each sample to the end; gated stops it at note off.',
      labels: { 'one-shot': 'One-shot', gate: 'Gated' },
    }),
    tune: num(-24, 24, 0, {
      unit: 'st', center: 0, primary: true, label: 'Tune', description: 'Transpose every zone.',
    }),
    attack: num(0.001, 2, 0.001, {
      unit: 's', scale: 'log', label: 'Attack', description: 'Fade-in at the start of a note.',
    }),
    release: num(0.005, 4, 0.05, {
      unit: 's', scale: 'log', activeWhen: { mode: 'gate' },
      label: 'Release', description: 'Fade-out after the note ends.',
    }),
    gain: num(0, 1, 0.8, { unit: '%', primary: true, label: 'Level', description: 'Output level.' }),
  };
  static groups = [
    { id: 'playback', label: 'Playback', params: ['mode', 'tune'] },
    {
      id: 'amp', label: 'Amp envelope', params: ['attack', 'release'],
      role: 'envelope', bind: { attack: 'attack', release: 'release' },
    },
    { id: 'output', label: 'Output', params: ['gain'] },
  ];
  static presets = {
    'Kit': { mode: 'one-shot', attack: 0.001 },
    'Keys': { mode: 'gate', attack: 0.002, release: 0.3 },
    'Pad': { mode: 'gate', attack: 0.4, release: 1.5 },
  };

  constructor(ctx, params) {
    super(ctx, params);
    this.zones = [];
    this.voices = new Map();   // note -> { source, amp }
  }

  static fromJSON(ctx, json) {
    const sampler = new this(ctx, json?.params);
    if (Array.isArray(json?.samples)) sampler.ready = sampler.load(json.samples);
    return sampler;
  }

  async load(zones) {
    const list = Array.isArray(zones) ? zones : [{ sample: zones }];
    this.zones = await Promise.all(list.map(async ({ sample, root = 60, lo = 0, hi = 127, label }) => {
      const buffer = sample instanceof AudioBuffer ? sample : await this.#fetch(sample);
      return { buffer, url: typeof sample === 'string' ? sample : null, root, lo, hi, label };
    }));
  }

  /**
   * A kit — every zone a single key — names its keys, from each zone's
   * `label`, else its file name, else the note. Anything with a zone
   * spanning a range is played chromatically, so it has none.
   */
  get keys() {
    if (!this.zones.length || this.zones.some((z) => z.lo !== z.hi)) return null;
    const keys = {};
    for (const { lo, label, url } of this.zones) {
      keys[lo] = label ?? url?.split('/').pop().replace(/\.\w+$/, '') ?? noteName(lo);
    }
    return keys;
  }

  async #fetch(url) {
    const bytes = await (await fetch(url)).arrayBuffer();
    return this.ctx.decodeAudioData(bytes);
  }

  noteOn(note, velocity = 1, time) {
    // Later zones win where ranges overlap, so a kit can override one key.
    const zone = this.zones.findLast((z) => note >= z.lo && note <= z.hi);
    if (!zone) return;

    const t = this.at(time);
    const p = this.params;
    this.#release(note, t, 0.005);

    const source = new AudioBufferSourceNode(this.ctx, {
      buffer: zone.buffer,
      playbackRate: 2 ** ((note - zone.root + p.tune) / 12),
    });
    const amp = new GainNode(this.ctx, { gain: 0 });
    source.connect(amp).connect(this.output);
    source.onended = () => {
      amp.disconnect();
      if (this.voices.get(note)?.source === source) this.voices.delete(note);
    };

    envStart(amp.gain, t, { attack: p.attack, decay: 0.01, sustain: 1, peak: velocity });
    source.start(t);
    this.voices.set(note, { source, amp });
  }

  noteOff(note, time) {
    if (this.params.mode === 'gate') this.#release(note, this.at(time), this.params.release);
  }

  allNotesOff(time) {
    const t = this.at(time);
    for (const note of [...this.voices.keys()]) this.#release(note, t, 0.005);
  }

  #release(note, t, release) {
    const voice = this.voices.get(note);
    if (!voice) return;
    this.voices.delete(note);
    envRelease(voice.amp.gain, t, release);
    voice.source.stop(t + release * 2 + 0.05);
  }

  toJSON() {
    const samples = this.zones
      .filter((z) => z.url)
      .map(({ url, root, lo, hi, label }) => ({ sample: url, root, lo, hi, label }));
    return { ...super.toJSON(), samples };
  }
}
