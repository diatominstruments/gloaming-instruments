/**
 * The sample banks a Sampler can play, keyed by the folder their files sit
 * in under `src/kits/` (copied to `dist/kits/` by the build). Banks are
 * hardcoded rather than discovered so every one carries its metadata, and
 * so a song names a bank by key instead of storing URLs: untrusted song
 * data can pick a bank but never make the player fetch anything else.
 *
 *   label  display name
 *   type   'kit': one sample per key, played one-shot with rows per sound;
 *          'pitched': zones spread across the keyboard and repitched
 *   zones  kits: { file, note, label, choke }
 *            note   one of KIT_SLOTS, which gives the sound its controls
 *            label  the key's name, if not the slot's
 *            choke  zones sharing a choke group cut each other off (the
 *                   closed hat silencing the open one)
 *          pitched: { file, lo, hi, root }
 *            lo/hi  the notes it plays on
 *            root   the note it plays at original speed (defaults to lo)
 */

/**
 * The notes a kit can use, each with its own tune, decay and level params
 * on the Sampler. They follow General MIDI, like DRUM, so a pattern written
 * for the drum synth plays the same sounds on a sampled kit. Params are
 * named after the slot, so a kit is free to put any sound on any slot, but
 * adding a slot adds params: extend this list rather than renaming it.
 */
export const KIT_SLOTS = deepFreeze({
  36: { id: 'kick', label: 'Kick' },
  37: { id: 'rim', label: 'Rim' },
  38: { id: 'snare', label: 'Snare' },
  39: { id: 'clap', label: 'Clap' },
  42: { id: 'closedHat', label: 'Closed hat' },
  44: { id: 'pedalHat', label: 'Pedal hat' },
  45: { id: 'lowTom', label: 'Low tom' },
  46: { id: 'openHat', label: 'Open hat' },
  47: { id: 'midTom', label: 'Mid tom' },
  49: { id: 'crash', label: 'Crash' },
  50: { id: 'highTom', label: 'High tom' },
  51: { id: 'ride', label: 'Ride' },
  54: { id: 'tambourine', label: 'Tambourine' },
});

export const SAMPLE_BANKS = deepFreeze({
  909: {
    label: 'TR-909',
    type: 'kit',
    zones: [
      { file: 'BD.WAV', note: 36 },
      { file: 'RIM.WAV', note: 37 },
      { file: 'SNARE.WAV', note: 38 },
      { file: 'CLAP.WAV', note: 39 },
      { file: 'CLOSED_HAT.WAV', note: 42, choke: 'hat' },
      { file: 'LOW_TOM.WAV', note: 45 },
      { file: 'OPEN_HAT.WAV', note: 46, choke: 'hat' },
      { file: 'MID_TOM.WAV', note: 47 },
      { file: 'CRASH.WAV', note: 49 },
      { file: 'HIGH_TOM.WAV', note: 50 },
      { file: 'RIDE.WAV', note: 51 },
    ],
  },
  DIRT: {
    label: 'Dirt',
    type: 'kit',
    zones: [
      { file: 'KICK.wav', note: 36 },
      { file: 'SNARE.wav', note: 38 },
      { file: 'HAT_1.wav', note: 42, label: 'Hat 1', choke: 'hat' },
      { file: 'HAT_2.wav', note: 44, label: 'Hat 2', choke: 'hat' },
      { file: 'SUB_BD.wav', note: 45, label: 'Sub kick' },
      { file: 'OPEN_HAT.wav', note: 46, choke: 'hat' },
      { file: 'PERC.wav', note: 54, label: 'Perc' },
    ],
  },
});

/** A bank's zones with the kit shorthand expanded: every zone has lo, hi and root. */
export function bankZones(key) {
  return (SAMPLE_BANKS[key]?.zones ?? []).map(({ note, lo = note, hi = note, root = lo, label, ...rest }) =>
    ({ ...rest, lo, hi, root, label: label ?? KIT_SLOTS[note]?.label }));
}

/** The keys of the banks of one type. */
export const banksOfType = (type) => Object.keys(SAMPLE_BANKS).filter((key) => SAMPLE_BANKS[key].type === type);

/** A kit's keys, { note: label }; null for pitched banks, which play chromatically. */
export function bankKeys(key) {
  const bank = SAMPLE_BANKS[key];
  if (bank?.type !== 'kit') return null;
  return Object.fromEntries(bankZones(key).map(({ lo, label }) => [lo, label]));
}

function deepFreeze(value) {
  if (value && typeof value === 'object') Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}
