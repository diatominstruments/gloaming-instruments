import { Instrument, num, choice } from '../module.js';
import { envStart, envRelease, noteName } from '../util.js';
import { SAMPLE_BANKS, bankZones, bankKeys } from './sample-banks.js';

// Where bank folders are served from. As an ES module the library finds
// src/kits/ beside its own source; the IIFE bundle has no import.meta, so it
// looks for dist/kits/ beside its <script>. Apps serving the kits elsewhere
// set Sampler.bankRoot.
const DEFAULT_BANK_ROOT = import.meta.url
  ? new URL('../kits/', import.meta.url).href
  : new URL('kits/', globalThis.document?.currentScript?.src ?? globalThis.location?.href ?? 'file:///').href;

// Decoded buffers, shared by every sampler on a context, so switching banks
// back and forth or running two samplers on one kit fetches each file once.
const buffers = new WeakMap();   // context -> Map(url -> Promise<AudioBuffer>)

function fetchBuffer(ctx, url) {
  let cache = buffers.get(ctx);
  if (!cache) buffers.set(ctx, (cache = new Map()));
  let buffer = cache.get(url);
  if (!buffer) {
    buffer = fetch(url)
      .then((response) => {
        if (!response.ok) throw new Error(`sampler: ${response.status} fetching ${url}`);
        return response.arrayBuffer();
      })
      .then((bytes) => ctx.decodeAudioData(bytes));
    buffer.catch(() => cache.delete(url));   // let a later load retry
    cache.set(url, buffer);
  }
  return buffer;
}

/**
 * Sampler — plays AudioBuffers across key zones. Its sounds come from one of
 * the hardcoded SAMPLE_BANKS, chosen by the `bank` param: a kit (one sample
 * per key, named in `keys`) or a pitched bank (zones across the keyboard).
 * A zone plays its sample at original speed on `root` and repitches from
 * there.
 *
 * In 'one-shot' mode noteOff is ignored and each note chokes its own
 * previous hit (like a drum machine pad); in 'gate' mode notes release on
 * noteOff. Zones sharing a `choke` group also cut each other off.
 *
 * Songs store only the bank's key, so loading one never fetches anything
 * but the bundled banks. `load(zones)` still takes zones directly, from
 * URLs or AudioBuffers, for code building its own instrument; those zones
 * last until the bank changes and aren't saved.
 */
export class Sampler extends Instrument {
  static id = 'sampler';
  static version = 2;
  static label = 'Sampler';
  static description = 'Plays a bank of samples: a drum kit with one sound per key, or a pitched instrument across the keyboard.';
  static tags = ['sampler', 'drums'];
  static gated = { mode: 'gate' };
  static params = {
    bank: choice(Object.keys(SAMPLE_BANKS), '909', {
      label: 'Bank', description: 'The set of samples to play.',
      labels: Object.fromEntries(Object.entries(SAMPLE_BANKS).map(([key, bank]) => [key, bank.label])),
    }),
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
    { id: 'playback', label: 'Playback', params: ['bank', 'mode', 'tune'] },
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
  /**
   * Every bank's metadata, { key: { label, type, keys } }, so an app can
   * show a kit's rows before anything loads. `keys` is null for pitched banks.
   */
  static banks = Object.fromEntries(Object.entries(SAMPLE_BANKS).map(([key, { label, type }]) =>
    [key, { label, type, keys: bankKeys(key) }]));
  /** Base URL of the bank folders; see DEFAULT_BANK_ROOT. */
  static bankRoot = DEFAULT_BANK_ROOT;

  /** The default bank's keys, for describe(); read `sampler.keys` on an instance. */
  static get keys() {
    return bankKeys(this.params.bank.default);
  }

  #custom = false;   // playing zones from load() rather than the bank
  #loading = null;   // the latest load, so a slow earlier one can't overwrite it

  constructor(ctx, params) {
    super(ctx, params);
    this.zones = [];
    this.voices = new Map();   // note -> { source, amp, choke }
    this.ready = this.#loadBank(this.params.bank);
  }

  applyParam(name, value, time) {
    super.applyParam(name, value, time);
    if (name === 'bank') {
      this.allNotesOff(time);
      this.ready = this.#loadBank(value);
    }
  }

  /** Play these zones instead of the bank, until the bank changes. */
  load(zones) {
    const list = Array.isArray(zones) ? zones : [{ sample: zones }];
    this.#custom = true;
    return (this.ready = this.#load(list));
  }

  #loadBank(key) {
    const root = new URL(`${key}/`, new URL(this.constructor.bankRoot, globalThis.location?.href));
    this.#custom = false;
    return this.#load(bankZones(key).map(({ file, ...zone }) => ({ ...zone, sample: new URL(file, root).href })));
  }

  async #load(list) {
    const loading = Symbol('load');
    this.#loading = loading;
    const zones = await Promise.all(list.map(async ({ sample, root = 60, lo = 0, hi = 127, label, choke }) => {
      const buffer = sample instanceof AudioBuffer ? sample : await fetchBuffer(this.ctx, sample);
      return { buffer, url: typeof sample === 'string' ? sample : null, root, lo, hi, label, choke };
    }));
    if (this.#loading === loading) this.zones = zones;
  }

  /**
   * A kit's keys, { note: label }: the bank's, known before it loads, or for
   * zones from load(), each single-key zone's label, else its file name,
   * else the note. Pitched banks, and anything with a zone spanning a
   * range, play chromatically and have none.
   */
  get keys() {
    if (!this.#custom) return bankKeys(this.params.bank);
    if (!this.zones.length || this.zones.some((z) => z.lo !== z.hi)) return null;
    const keys = {};
    for (const { lo, label, url } of this.zones) {
      keys[lo] = label ?? url?.split('/').pop().replace(/\.\w+$/, '') ?? noteName(lo);
    }
    return keys;
  }

  noteOn(note, velocity = 1, time) {
    // Later zones win where ranges overlap, so a kit can override one key.
    const zone = this.zones.findLast((z) => note >= z.lo && note <= z.hi);
    if (!zone) return;

    const t = this.at(time);
    const p = this.params;
    this.#release(note, t, 0.005);
    if (zone.choke) {
      for (const [other, voice] of this.voices) {
        if (voice.choke === zone.choke) this.#release(other, t, 0.005);
      }
    }

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
    this.voices.set(note, { source, amp, choke: zone.choke });
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
}
