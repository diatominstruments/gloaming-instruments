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
 */
export const num = (min, max, def, extra = {}) => ({ type: 'number', min, max, default: def, ...extra });
export const choice = (values, def) => ({ type: 'choice', values, default: def, automatable: false });

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

  constructor(ctx, params = {}) {
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
 * instead of a keyboard. Null for pitched instruments.
 */
export class Instrument extends Module {
  static kind = 'instrument';
  static keys = null;

  constructor(ctx, params) {
    super(ctx, params);
    this.output = new GainNode(ctx, { gain: this.params.gain ?? 1 });
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
