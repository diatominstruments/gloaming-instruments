// Checks every registered module's display metadata against its param
// schema, so groups, presets and conditions can't drift out of step with
// the params they describe. No AudioContext needed: it's all static.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  registry, manifest, describe, sanitizeParams, matches, noteName, parseNote, UNITS, Effect, num,
} from '../src/index.js';

const ROLES = {
  envelope: ['attack', 'decay', 'sustain', 'release', 'amount'],
  filter: ['type', 'cutoff', 'resonance'],
  dynamics: ['threshold', 'ratio', 'knee'],
};

// A condition names choice params, with values those choices can take.
function checkCondition(M, where, condition) {
  for (const [name, want] of Object.entries(condition)) {
    const spec = M.params[name];
    assert.equal(spec?.type, 'choice', `${where}: condition on '${name}', which isn't a choice`);
    for (const v of [want].flat()) assert.ok(spec.values.includes(v), `${where}: '${name}' can't be '${v}'`);
  }
}

for (const M of registry.values()) {
  test(M.id, async (t) => {
    await t.test('module fields', () => {
      assert.ok(M.label, 'label');
      assert.ok(M.description, 'description');
      assert.ok(M.tags.length, 'tags');
      if (M.kind === 'instrument') {
        assert.ok(M.polyphony === null || (Number.isInteger(M.polyphony) && M.polyphony > 0), 'polyphony');
        if (typeof M.gated !== 'boolean') checkCondition(M, 'gated', M.gated);
      }
    });

    await t.test('params', () => {
      for (const [name, spec] of Object.entries(M.params)) {
        const where = `param '${name}'`;
        assert.ok(spec.label, `${where}: label`);
        assert.ok(spec.description, `${where}: description`);
        if (spec.type === 'choice') {
          assert.ok(spec.values.includes(spec.default), `${where}: default`);
          if (spec.labels) assert.deepEqual(Object.keys(spec.labels).sort(), [...spec.values].sort(), `${where}: labels`);
          continue;
        }
        const inRange = (v) => v >= spec.min && v <= spec.max;
        assert.ok(inRange(spec.default), `${where}: default in range`);
        if (spec.unit) assert.ok(UNITS.includes(spec.unit), `${where}: unknown unit '${spec.unit}'`);
        if (spec.unit === '%') assert.ok(spec.min >= 0 && spec.max <= 1, `${where}: '%' is a 0..1 fraction`);
        if (spec.scale === 'log') assert.ok(spec.min > 0, `${where}: log needs min > 0`);
        if (spec.center != null) assert.ok(inRange(spec.center), `${where}: center in range`);
        for (const mark of spec.marks ?? []) assert.ok(inRange(mark.value) && mark.label, `${where}: mark ${mark.value}`);
        if (spec.activeWhen) checkCondition(M, where, spec.activeWhen);
      }
      const primary = Object.values(M.params).filter((s) => s.primary).length;
      assert.ok(primary >= 1 && primary <= 3, `${primary} primary params; want 1 to 3`);
    });

    await t.test('groups', () => {
      const seen = new Map();
      const ids = new Set();
      for (const group of M.groups) {
        assert.ok(group.label, `group '${group.id}': label`);
        assert.ok(!ids.has(group.id), `duplicate group id '${group.id}'`);
        ids.add(group.id);
        for (const name of group.params) {
          assert.ok(M.params[name], `group '${group.id}': unknown param '${name}'`);
          assert.ok(!seen.has(name), `'${name}' is in both '${seen.get(name)}' and '${group.id}'`);
          seen.set(name, group.id);
        }
        for (const note of group.notes ?? []) {
          assert.ok(M.keys?.[note], `group '${group.id}': note ${note} isn't one of the instrument's keys`);
        }
        if (group.role) {
          assert.ok(ROLES[group.role], `group '${group.id}': unknown role '${group.role}'`);
          for (const [slot, target] of Object.entries(group.bind ?? {})) {
            assert.ok(ROLES[group.role].includes(slot), `group '${group.id}': '${group.role}' has no slot '${slot}'`);
            if (typeof target === 'string') assert.ok(M.params[target], `group '${group.id}': '${slot}' → unknown '${target}'`);
            else assert.ok('value' in target, `group '${group.id}': '${slot}' is neither a param nor { value }`);
          }
        }
      }
      const missing = Object.keys(M.params).filter((name) => !seen.has(name));
      assert.deepEqual(missing, [], 'params in no group');
    });

    await t.test('presets', () => {
      assert.ok(Object.keys(M.presets).length, 'at least one preset');
      for (const [preset, params] of Object.entries(M.presets)) {
        for (const [name, value] of Object.entries(params)) {
          assert.ok(M.params[name], `preset '${preset}': unknown param '${name}'`);
          assert.equal(sanitizeParams(M, params)[name], value, `preset '${preset}': '${name}' out of range`);
        }
      }
    });
  });
}

test('manifest is plain JSON covering the registry', () => {
  const list = manifest();
  assert.equal(list.length, registry.size);
  assert.deepEqual(JSON.parse(JSON.stringify(list)), list);
  const drums = list.find((m) => m.id === 'drum-synth');
  assert.equal(drums.keys[36], 'Kick');
  assert.equal(drums.gated, false);
});

test('describe fills in defaults for a module without metadata', () => {
  class Bare extends Effect {
    static id = 'bare-thing';
    static params = { wetLevel: num(0, 1, 0.5) };
  }
  const info = describe(Bare);
  assert.equal(info.label, 'Bare thing');
  assert.equal(info.params.wetLevel.label, 'Wet level');
  assert.deepEqual(info.groups, [{ id: 'params', label: 'Parameters', params: ['wetLevel'] }]);
  assert.equal(info.polyphony, undefined);
});

test('matches', () => {
  assert.equal(matches(true, {}), true);
  assert.equal(matches(false, {}), false);
  assert.equal(matches(undefined, {}), true);
  assert.equal(matches({ mode: 'gate' }, { mode: 'gate' }), true);
  assert.equal(matches({ mode: 'gate' }, { mode: 'one-shot' }), false);
  assert.equal(matches({ type: ['lowpass', 'bandpass'] }, { type: 'bandpass' }), true);
});

test('noteName inverts parseNote', () => {
  for (const name of ['C-4', 'C#4', 'A-4', 'B-0', 'D#9']) assert.equal(noteName(parseNote(name)), name);
});
