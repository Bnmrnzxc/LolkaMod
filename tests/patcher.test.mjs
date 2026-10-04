import assert from 'node:assert/strict';
import test from 'node:test';

import { after, before, instead } from '../dist/patcher.mjs';

test('multiple owners can be removed in either order without losing remaining layers', () => {
  const object = { method(value) { return value + 1; } };
  const removeFirst = instead('first', object, 'method', (args, next) => next(...args) + 10);
  const removeSecond = instead('second', object, 'method', (args, next) => next(...args) * 2);

  assert.equal(object.method(2), 26);
  removeFirst();
  assert.equal(object.method(2), 6);
  removeFirst();
  assert.equal(object.method(2), 6);
  removeSecond();
  assert.equal(object.method(2), 3);

  const removeOuter = instead('outer', object, 'method', (args, next) => next(...args) * 3);
  const removeInner = instead('inner', object, 'method', (args, next) => next(...args) + 7);
  assert.equal(object.method(2), 16);
  removeInner();
  assert.equal(object.method(2), 9);
  removeOuter();
  assert.equal(object.method(2), 3);
});

test('inherited methods preserve this, arguments, async results, and original throws once', async () => {
  class Parent {
    constructor(prefix) { this.prefix = prefix; this.calls = 0; }
    async combine(...args) {
      this.calls += 1;
      if (args[0] === 'throw') throw new Error('host failure');
      return `${this.prefix}:${args.join('|')}`;
    }
  }
  const instance = new Parent('host');
  const removeBefore = before('inspect-args', instance, 'combine', (args, self) => {
    assert.strictEqual(self, instance);
    assert.deepEqual(args, ['one', 2]);
  });
  const removeAfter = after('append-result', instance, 'combine', (result, args, self) => {
    assert.deepEqual(args, ['one', 2]);
    assert.strictEqual(self, instance);
    return `${result}:after`;
  });

  assert.equal(await instance.combine('one', 2), 'host:one|2:after');
  assert.equal(instance.calls, 1);
  removeAfter();
  removeBefore();
  assert.equal(Object.hasOwn(instance, 'combine'), false);

  const removeThrowingLayer = instead('throw-probe', instance, 'combine', (args, next) => next(...args));
  await assert.rejects(instance.combine('throw'), /host failure/);
  assert.equal(instance.calls, 2);
  removeThrowingLayer();
  assert.equal(Object.hasOwn(instance, 'combine'), false);
});

test('disposing a patch does not overwrite a later foreign method replacement', () => {
  const object = { method() { return 'original'; } };
  const remove = instead('owner', object, 'method', (_args, next) => `wrapped:${next()}`);
  assert.equal(object.method(), 'wrapped:original');

  const foreign = function foreignReplacement() { return 'foreign'; };
  object.method = foreign;
  remove();
  assert.strictEqual(object.method, foreign);
  assert.equal(object.method(), 'foreign');
});
