'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const plugin = require('../index');
const { Script2DeviceLogic, Script2Platform } = plugin;
const { validate } = require('../homebridge-ui/public/validation');

// presentState reads the module-level Characteristic, set when the plugin loads.
plugin({ hap: { Characteristic: { On: 'On' }, Service: {} }, registerPlatform() {} });

const quiet = Object.fromEntries(['debug', 'info', 'warn', 'error'].map((level) => [level, () => {}]));

function member(name, config = {}) {
  const commands = [];
  const logic = new Script2DeviceLogic(quiet, {
    name, on: `on-${name}`, off: `off-${name}`, state: `state-${name}`, exclusive_group: 'inputs', ...config,
  }, (command, options, callback) => commands.push({ command, callback }));
  const shown = [];
  logic.switchService = { updateCharacteristic: (characteristic, value) => shown.push(value) };
  return { logic, commands, shown };
}

function group(...names) {
  const members = names.map((name) => member(name));
  for (const m of members) m.logic.exclusivePeers = members.filter((p) => p !== m).map((p) => p.logic);
  return members;
}

test('a successful ON shows every other member OFF without running their commands', () => {
  const [ps5, nsw, atv] = group('PS5', 'Switch', 'ATV');
  ps5.logic.setState(true, () => {});
  ps5.commands[0].callback(null, '', '');
  assert.deepEqual(nsw.shown, [false]);
  assert.deepEqual(atv.shown, [false]);
  assert.deepEqual(ps5.shown, []);
  assert.equal(nsw.commands.length, 0);
  assert.equal(atv.commands.length, 0);
});

test('OFF, and an ON that fails, leave the others alone', () => {
  const [ps5, nsw] = group('PS5', 'Switch');
  ps5.logic.setState(false, () => {});
  ps5.commands[0].callback(null, '', '');
  ps5.logic.setState(true, () => {});
  ps5.commands[1].callback(Object.assign(new Error('fail'), { code: 1 }), '', '');
  assert.deepEqual(nsw.shown, []);
});

test('a HomeKit read just after is served OFF from the cache, not the stale ON', () => {
  const [ps5, nsw] = group('PS5', 'Switch');
  nsw.logic.lastStateRead = true;
  nsw.logic.lastStateReadAt = Date.now();
  ps5.logic.setState(true, () => {});
  ps5.commands[0].callback(null, '', '');
  let read;
  nsw.logic.getState((error, on, source) => { read = { error, on, source }; });
  assert.deepEqual(read, { error: null, on: false, source: 'ttl-cache' });
  assert.equal(nsw.commands.length, 0);
});

test('a read in flight is answered OFF and its late result discarded', () => {
  const [ps5, nsw] = group('PS5', 'Switch');
  const answers = [];
  nsw.logic.getState((error, on, source) => answers.push({ on, source }), 'homekit-get');
  nsw.logic.getState((error, on, source) => answers.push({ on, source }), 'homekit-get');
  assert.equal(nsw.commands.length, 1);
  ps5.logic.setState(true, () => {});
  ps5.commands[0].callback(null, '', '');
  // The second caller joined the first's read, so it is relabelled on the way out.
  assert.deepEqual(answers.map((a) => a.on), [false, false]);
  nsw.commands[0].callback(null, 'true\n', '');
  assert.equal(answers.length, 2);
  assert.equal(nsw.logic.lastStateRead, false);
});

test('a member with its own set in flight is left to finish', () => {
  const [ps5, nsw] = group('PS5', 'Switch');
  nsw.logic.setState(true, () => {});
  ps5.logic.setState(true, () => {});
  ps5.commands[0].callback(null, '', '');
  assert.deepEqual(nsw.shown, []);
  nsw.commands[0].callback(null, '', '');
  assert.deepEqual(ps5.shown, [false]);
});

test('reads parked behind a failed set are answered rather than left hanging', () => {
  const [ps5, nsw] = group('PS5', 'Switch');
  const answers = [];
  nsw.logic.setState(true, () => {});
  nsw.logic.getState((error, on, source) => answers.push({ on, source }), 'homekit-get');
  nsw.commands[0].callback(Object.assign(new Error('fail'), { code: 1 }), '', '');
  assert.equal(nsw.commands.length, 2);
  ps5.logic.setState(true, () => {});
  ps5.commands[0].callback(null, '', '');
  assert.deepEqual(answers, [{ on: false, source: 'exclusive-group' }]);
  nsw.commands[1].callback(null, 'true\n', '');
  assert.equal(answers.length, 1);
});

test('the platform links members by group name, and only within a group', () => {
  const api = new EventEmitter();
  api.hap = { Service: { AccessoryInformation: 'info', Switch: 'switch' }, Characteristic: { On: 'On', Manufacturer: 'M', Model: 'Model', SerialNumber: 'Serial' }, uuid: { generate: (v) => v } };
  api.platformAccessory = class {
    constructor(name, uuid) { this.displayName = name; this.UUID = uuid; this.context = {}; this.characteristic = new EventEmitter(); }
    getService(type) { return type === 'info' ? { setCharacteristic() { return this; } } : { getCharacteristic: () => this.characteristic, updateCharacteristic() {} }; }
  };
  api.registerPlatformAccessories = () => {};
  api.updatePlatformAccessories = () => {};
  api.unregisterPlatformAccessories = () => {};
  api.registerPlatform = () => {};
  plugin(api);
  const warnings = [];
  const log = { ...quiet, warn: (m) => warnings.push(m) };
  const sw = (name, extra) => ({ name, on: 'on', off: 'off', state: 'state', polling_on_start: false, ...extra });
  const platform = new Script2Platform(log, {
    platform: 'Script2Platform',
    on_off_switches: [sw('PS5', { exclusive_group: 'inputs' }), sw('Switch', { exclusive_group: ' inputs ' }), sw('eARC', { exclusive_group: 'audio' }), sw('Lamp')],
    stateless_switches: [{ name: 'Run', trigger: 'run' }],
  }, api);
  api.emit('didFinishLaunching');
  const peers = (name) => platform.instances.get(`homebridge-script2:${name}`).exclusivePeers.map((p) => p.name);
  assert.deepEqual(peers('PS5'), ['Switch']);
  assert.deepEqual(peers('Switch'), ['PS5']);
  assert.deepEqual(peers('eARC'), []);
  assert.deepEqual(peers('Lamp'), []);
  assert.deepEqual(peers('Run'), []);
  assert.ok(warnings.some((m) => m.includes("'audio'")));
  for (const instance of platform.instances.values()) instance.shutdown();
});

test('validation accepts a group name on on/off switches only', () => {
  const sw = { name: 'PS5', on: 'on', off: 'off', state: 'state' };
  assert.equal(validate({ platform: 'Script2Platform', on_off_switches: [{ ...sw, exclusive_group: 'inputs' }] }).valid, true);
  assert.equal(validate({ platform: 'Script2Platform', on_off_switches: [{ ...sw, exclusive_group: '' }] }).valid, false);
  assert.equal(validate({ platform: 'Script2Platform', on_off_switches: [{ ...sw, exclusive_group: 3 }] }).valid, false);
  assert.equal(validate({ platform: 'Script2Platform', stateless_switches: [{ name: 'Run', trigger: 'run', exclusive_group: 'inputs' }] }).valid, false);
});

test('an OFF from Home is checked against the device shortly after', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const [ps5] = group('PS5', 'Switch');
  ps5.logic.lastStateRead = true;
  ps5.logic.lastStateReadAt = Date.now();
  ps5.logic.setState(false, () => {});
  ps5.commands[0].callback(null, '', '');
  assert.equal(ps5.commands.length, 1);
  t.mock.timers.tick(500);
  // A fresh read: the cached ON from before the OFF must not answer it.
  assert.equal(ps5.commands[1].command, 'state-PS5');
  ps5.commands[1].callback(null, 'true\n', '');
  assert.deepEqual(ps5.shown, [true]);
  assert.equal(ps5.logic.currentState, true);
});

test('an OFF the device really took is left as it is', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const [ps5] = group('PS5', 'Switch');
  ps5.logic.setState(false, () => {});
  ps5.commands[0].callback(null, '', '');
  t.mock.timers.tick(500);
  ps5.commands[1].callback(null, 'false\n', '');
  assert.deepEqual(ps5.shown, []);
});

test('a peer turning ON before the check cancels it', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const [ps5, nsw] = group('PS5', 'Switch');
  ps5.logic.setState(false, () => {});
  ps5.commands[0].callback(null, '', '');
  nsw.logic.setState(true, () => {});
  nsw.commands[0].callback(null, '', '');
  t.mock.timers.tick(500);
  assert.equal(ps5.commands.length, 1);
  assert.deepEqual(ps5.shown, [false]);
});

test('a peer turning ON during the check discards its result', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const [ps5, nsw] = group('PS5', 'Switch');
  ps5.logic.setState(false, () => {});
  ps5.commands[0].callback(null, '', '');
  t.mock.timers.tick(500);
  nsw.logic.setState(true, () => {});
  nsw.commands[0].callback(null, '', '');
  ps5.commands[1].callback(null, 'true\n', '');
  assert.deepEqual(ps5.shown, [false]);
});

test('no check after a failed OFF, outside a group, or once stopped', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const [ps5] = group('PS5', 'Switch');
  ps5.logic.setState(false, () => {});
  ps5.commands[0].callback(Object.assign(new Error('fail'), { code: 1 }), '', '');
  t.mock.timers.tick(500);
  assert.equal(ps5.commands.length, 1);

  const lamp = member('Lamp', { exclusive_group: undefined });
  lamp.logic.setState(false, () => {});
  lamp.commands[0].callback(null, '', '');
  t.mock.timers.tick(500);
  assert.equal(lamp.commands.length, 1);

  const [nsw] = group('Switch', 'ATV');
  nsw.logic.setState(false, () => {});
  nsw.commands[0].callback(null, '', '');
  nsw.logic.shutdown();
  t.mock.timers.tick(500);
  assert.equal(nsw.commands.length, 1);
});
