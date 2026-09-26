import { clamp, SMOOTH } from './util.js';

/**
 * Param schema helpers. Every module declares its knobs up front:
 *
 *   static params = {
 *     cutoff: num(30, 16000, 600, { unit: 'Hz', scale: 'log' }),
 *     wave:   choice(['sawtooth', 'square'], 'sawtooth'),
 *   };
 *
 * The schema is the whole contract with the outside world. A UI builds its
 * controls from it, a song file stores values against it, and anything
 * arriving from an untrusted song is clamped to it — so a shared song can
 * never push a module outside the ranges its author tested.
 *
 *   scale        'linear' (default) or 'log', a hint for UI controls; a log
 *                param must have min > 0
 *   automatable  false for params that rebuild part of the graph when they
 *                change (and for every choice): fine to set, but a sequencer
 *                shouldn't sweep them per row
 *
 * The rest is display metadata. It never affects the sound, and all of it is
 * optional, so a module without it still gets a usable (if plain) UI.
 *
 *   label        display name, written to be read under its group's heading
 *                ('Decay' in a 'Filter envelope' group); defaults to the
 *                param name split out of camelCase
 *   description  one sentence on what it does, for tooltips and help
 *   unit         one of UNITS, so an app can format values (0.02 s → 20 ms)
 *   labels       choices only: display names for the values, { value: label };
 *                the values themselves are ids stored in songs
 *   marks        named points on a number's range, [{ value, label }], for
 *                ticks or detents (the vowels on a formant synth's `vowel`)
 *   center       the value a control rests at and fills outward from, for
 *                ranges that straddle zero (a tune knob fills from 0)
 *   primary      true on the two or three params worth showing when there's
 *                only room for a few, like a collapsed card or a mixer strip
 *   activeWhen   { param: value | [values] }: the param only has an effect
 *                while those choices are set (release only matters when
 *                `mode` is 'gate'); an app can hide or dim it otherwise
 */
export const num = (min, max, def, extra = {}) => ({ type: 'number', min, max, default: def, ...extra });
export const choice = (values, def, extra = {}) => ({ type: 'choice', values, default: def, automatable: false, ...extra });

/**
 * The units a param may declare. Values are stored in these units, except
 * '%', which is a 0..1 fraction to be shown multiplied by 100.
 *
 *   Hz  frequency        s   time           dB  decibels
 *   st  semitones        ct  cents          oct octaves
 *   m   metres           %   0..1 fraction  ×   multiplier
 *   :1  ratio (4 is 4:1)
 */
export const UNITS = Object.freeze(['Hz', 's', 'dB', 'st', 'ct', 'oct', 'm', '%', '×', ':1']);

/**
 * Whether a condition (`activeWhen`, or an instrument's `gated`) holds for a
 * set of param values. `true`/`false` stand for themselves; an object maps
 * param names to the value, or list of values, each must have.
 */
export function matches(condition, params) {
  if (typeof condition === 'boolean') return condition;
  if (!condition) return true;
  return Object.entries(condition).every(([name, want]) =>
    Array.isArray(want) ? want.includes(params[name]) : params[name] === want);
}

/** 'filterDecay' → 'Filter decay', 'mono-synth' → 'Mono synth'. */
const humanize = (name) => {
  const words = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/-/g, ' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/**
 * A module's metadata as plain JSON: everything an app needs to build a UI,
 * a picker or a preset browser without importing the class. Fills in the
 * defaults (labels from names, one group holding every param), so consumers
 * never have to handle missing fields.
 */
export function describe(M) {
  const params = {};
  for (const [name, spec] of Object.entries(M.params)) {
    params[name] = { ...spec, label: spec.label ?? humanize(name) };
  }
  const info = {
    id: M.id,
    kind: M.kind,
    version: M.version,
    label: M.label ?? humanize(M.id),
    description: M.description,
    tags: [...M.tags],
    params,
    groups: M.groups ?? [{ id: 'params', label: 'Parameters', params: Object.keys(M.params) }],
    presets: M.presets,
  };
  if (M.kind === 'instrument') Object.assign(info, { polyphony: M.polyphony, gated: M.gated, keys: M.keys });
  return JSON.parse(JSON.stringify(info));
}

function sanitize(spec, value, fallback) {
  if (spec.type === 'choice') return spec.values.includes(value) ? value : fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return clamp(value, spec.min, spec.max);
}

/**
 * Clean a params object against a module's schema without building it (no
 * AudioContext needed): known params clamped, bad values defaulted, unknown
 * keys dropped. For validating songs server-side.
 */
export function sanitizeParams(M, params) {
  params = M.upgradeParams(params);
  const clean = {};
  for (const [name, spec] of Object.entries(M.params)) {
    clean[name] = sanitize(spec, params?.[name], spec.default);
  }
  return clean;
}

/**
 * Module — shared base for instruments and effects. Holds validated param
 * values, and serializes to the `{ id, version, params }` form a song stores.
 *
 * Params are validated in the base constructor, *before* the subclass builds
 * its graph, so a subclass reads `this.params` to set up its nodes and
 * implements `applyParam(name, value, time)` for changes after that. Params
 * that only matter at note-on can skip applyParam entirely — the instrument
 * reads `this.params` when the note starts.
 *
 * Every time argument is AudioContext time in seconds, so a sequencer can
 * schedule ahead of playback. Omitted or past times mean "now".
 */
export class Module {
  static id = null;
  static kind = null;
  /** Bump when a change would make existing songs sound different. */
  static version = 1;
  static params = {};

  // ---- display metadata (see `describe`) ----
  static label = null;
  /** One sentence, for pickers and help. */
  static description = '';
  /**
   * Loose categories for browsing. Instruments use bass, lead, keys, pad,
   * pluck, bell, mallet, voice, drums, percussion, sampler; effects use
   * filter, distortion, dynamics, time, space, modulation, character.
   */
  static tags = [];
  /**
   * Params in display order, as sections: [{ id, label, params: [names] }].
   * Every param belongs to exactly one group. Optional extras:
   *
   *   notes  instruments with `keys`: the notes this group's params shape,
   *          so a drum row can open its own controls
   *   role   what the group is, for apps that draw more than knobs:
   *            'envelope'  bind: attack, decay, sustain, release, amount
   *            'filter'    bind: type, cutoff, resonance
   *            'dynamics'  bind: threshold, ratio, knee
   *          An app that doesn't know a role ignores it.
   *   bind   role slot → param name, or { value } for a slot the module
   *          fixes. Slots can be left out, and may name params from other
   *          groups (an FM mod envelope shares the amp's attack).
   *
   * Null gives one group holding every param.
   */
  static groups = null;
  /**
   * Starting points, { name: params }. Unlisted params take their defaults,
   * so `sanitizeParams(M, M.presets[name])` gives the full set.
   */
  static presets = {};

  /**
   * Translate params saved under an older schema (renamed or rescaled
   * params) into the current one, so a module can reshape its params
   * without old songs changing sound. Runs before validation, on anything
   * passed to the constructor or `sanitizeParams`.
   */
  static upgradeParams(params) {
    return params;
  }

  constructor(ctx, params = {}) {
    params = this.constructor.upgradeParams(params);
    this.ctx = ctx;
    this.params = {};
    for (const [name, spec] of Object.entries(this.constructor.params)) {
      this.params[name] = sanitize(spec, params?.[name], spec.default);
    }
    // Resolves once any async assets (samples) are loaded. Most modules have none.
    this.ready = Promise.resolve();
  }

  setParam(name, value, time) {
    const spec = this.constructor.params[name];
    if (!spec) throw new Error(`${this.constructor.id}: unknown param '${name}'`);
    const v = sanitize(spec, value, this.params[name]);
    this.params[name] = v;
    this.applyParam(name, v, this.at(time));
  }

  applyParam(_name, _value, _time) {}

  at(time) {
    return Math.max(time ?? 0, this.ctx.currentTime);
  }

  toJSON() {
    const { id, version } = this.constructor;
    return { id, version, params: { ...this.params } };
  }

  static fromJSON(ctx, json) {
    return new this(ctx, json?.params);
  }

  dispose() {
    this.output.disconnect();
  }
}

/**
 * Instrument — takes sequencer input, produces audio on `this.output`.
 *
 *   noteOn(note, velocity, time)   note: MIDI number, velocity: 0..1
 *   noteOff(note, time)
 *   allNotesOff(time)              on stop and seek; cuts everything quickly
 *
 * Events must arrive in time order, which any sequencer does naturally.
 * An instrument may ignore noteOff (drums are one-shots).
 *
 * Instruments declaring a `gain` param get it applied to the output here.
 *
 * `static keys` names the notes an instrument that isn't played chromatically
 * responds to, as { note: label }, so a sequencer can show one row per sound
 * instead of a keyboard. Null for pitched instruments. Read `instrument.keys`
 * where you have an instance: a sampler's depends on what it has loaded.
 *
 * `static polyphony` is how many notes can sound at once (null: no fixed
 * limit), and `static gated` whether noteOff ends a note — true, false, or a
 * condition on params as for `activeWhen`. A sequencer can show note lengths
 * for gated instruments and bare triggers for the rest.
 */
export class Instrument extends Module {
  static kind = 'instrument';
  static keys = null;
  static polyphony = null;
  static gated = true;

  constructor(ctx, params) {
    super(ctx, params);
    this.output = new GainNode(ctx, { gain: this.params.gain ?? 1 });
  }

  get keys() {
    return this.constructor.keys;
  }

  noteOn(_note, _velocity = 1, _time) {}
  noteOff(_note, _time) {}
  allNotesOff(_time) {}

  applyParam(name, value, time) {
    if (name === 'gain') this.output.gain.setTargetAtTime(value, time, SMOOTH);
  }
}

/**
 * Effect — audio in on `this.input`, modified audio out on `this.output`.
 * Both are plain GainNodes, so an effect's internals can be rebuilt without
 * anything upstream or downstream having to reconnect.
 */
export class Effect extends Module {
  static kind = 'effect';

  constructor(ctx, params) {
    super(ctx, params);
    this.input = new GainNode(ctx);
    this.output = new GainNode(ctx);
  }

  dispose() {
    this.input.disconnect();
    super.dispose();
  }
}

/**
 * Connect stages in series and return the last one. Stages are instruments,
 * effects or raw AudioNodes; only the first may be an instrument.
 *
 *   chain(synth, drive, delay, masterBus);
 */
export function chain(...stages) {
  for (let i = 0; i < stages.length - 1; i++) {
    const from = stages[i] instanceof AudioNode ? stages[i] : stages[i].output;
    const to = stages[i + 1] instanceof AudioNode ? stages[i + 1] : stages[i + 1].input;
    if (!to) throw new Error('chain: an instrument can only be the first stage');
    from.connect(to);
  }
  return stages.at(-1);
}
