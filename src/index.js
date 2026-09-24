import { Module } from './module.js';
import { MonoSynth } from './instruments/mono-synth.js';
import { FMSynth } from './instruments/fm-synth.js';
import { DrumSynth } from './instruments/drum-synth.js';
import { Sampler } from './instruments/sampler.js';
import { Filter } from './effects/filter.js';
import { Drive } from './effects/drive.js';
import { Delay } from './effects/delay.js';
import { Reverb } from './effects/reverb.js';

export { Module, Instrument, Effect, chain, num, choice, sanitizeParams } from './module.js';
export { mtof, parseNote } from './util.js';
export { DRUM } from './instruments/drum-synth.js';
export { MonoSynth, FMSynth, DrumSynth, Sampler, Filter, Drive, Delay, Reverb };

/** Every known module, instruments and effects alike, keyed by id. */
export const registry = new Map(
  [MonoSynth, FMSynth, DrumSynth, Sampler, Filter, Drive, Delay, Reverb].map((M) => [M.id, M]),
);

/** Ids as constants, read off the classes so a rename can't leave these stale. */
export const INSTRUMENT = Object.freeze({
  MONO_SYNTH: MonoSynth.id,
  FM_SYNTH: FMSynth.id,
  DRUM_SYNTH: DrumSynth.id,
  SAMPLER: Sampler.id,
});

export const EFFECT = Object.freeze({
  FILTER: Filter.id,
  DRIVE: Drive.id,
  DELAY: Delay.id,
  REVERB: Reverb.id,
});

/** Add a third-party instrument or effect, making it loadable from song files. */
export function register(M) {
  if (!(M.prototype instanceof Module) || !M.id) {
    throw new Error('register: expected an Instrument or Effect subclass with a static id');
  }
  if (registry.has(M.id)) throw new Error(`register: '${M.id}' is already registered`);
  registry.set(M.id, M);
}

/**
 * Build a module from its saved `{ id, version, params }` form. Params are
 * clamped to the schema, so this is safe to call on untrusted song data.
 * Await `module.ready` before playing if the module might load samples.
 */
export function create(ctx, json) {
  const M = registry.get(json?.id);
  if (!M) throw new Error(`create: unknown module '${json?.id}'`);
  if (json.version != null && json.version !== M.version) {
    console.warn(`create: '${M.id}' saved at v${json.version}, loaded at v${M.version}; it may sound different`);
  }
  return M.fromJSON(ctx, json);
}
