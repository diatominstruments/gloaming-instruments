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
 *   zones  { file, lo, hi, root, label, choke }
 *            file   in the bank's folder
 *            lo/hi  the notes it plays on; a kit zone gives just `note`
 *            root   the note it plays at original speed (defaults to lo)
 *            label  kits: the key's name
 *            choke  zones sharing a choke group cut each other off (the
 *                   closed hat silencing the open one)
 *
 * Kit notes follow General MIDI, like DRUM, so a pattern written for the
 * drum synth plays the same sounds on a sampled kit.
 */
export const SAMPLE_BANKS = deepFreeze({
  909: {
    label: 'TR-909',
    type: 'kit',
    zones: [
      { file: 'BD.WAV', note: 36, label: 'Kick' },
      { file: 'RIM.WAV', note: 37, label: 'Rim' },
      { file: 'SNARE.WAV', note: 38, label: 'Snare' },
      { file: 'CLAP.WAV', note: 39, label: 'Clap' },
      { file: 'CLOSED_HAT.WAV', note: 42, label: 'Closed hat', choke: 'hat' },
      { file: 'LOW_TOM.WAV', note: 45, label: 'Low tom' },
      { file: 'OPEN_HAT.WAV', note: 46, label: 'Open hat', choke: 'hat' },
      { file: 'MID_TOM.WAV', note: 47, label: 'Mid tom' },
      { file: 'CRASH.WAV', note: 49, label: 'Crash' },
      { file: 'HIGH_TOM.WAV', note: 50, label: 'High tom' },
      { file: 'RIDE.WAV', note: 51, label: 'Ride' },
    ],
  },
});

/** A bank's zones with the kit shorthand expanded: every zone has lo, hi and root. */
export function bankZones(key) {
  return (SAMPLE_BANKS[key]?.zones ?? []).map(({ note, lo = note, hi = note, root = lo, ...rest }) =>
    ({ ...rest, lo, hi, root }));
}

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
