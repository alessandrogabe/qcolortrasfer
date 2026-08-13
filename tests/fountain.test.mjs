import test from 'node:test';
import assert from 'node:assert/strict';
import { FountainEncoder, FountainDecoder, indicesForSymbol } from '../js/fountain.js';

test('systematic symbols map one-to-one', () => {
  assert.deepEqual(indicesForSymbol(0, 4), [0]);
  assert.deepEqual(indicesForSymbol(3, 4), [3]);
});

test('fountain decoder reconstructs from all systematic symbols out of order', () => {
  const input = Uint8Array.from({ length: 997 }, (_, i) => (i * 17 + 3) & 255);
  const encoder = new FountainEncoder(input, 128);
  const decoder = new FountainDecoder(encoder.sourceCount, encoder.chunkSize, input.length);
  for (let id = encoder.sourceCount - 1; id >= 0; id--) decoder.addSymbol(id, encoder.symbol(id).data);
  assert.equal(decoder.complete, true);
  assert.deepEqual(decoder.reconstruct(), input);
});

test('repair symbols recover dropped systematic symbols', () => {
  const input = Uint8Array.from({ length: 2048 }, (_, i) => (i * 29 + 11) & 255);
  const encoder = new FountainEncoder(input, 128);
  const decoder = new FountainDecoder(encoder.sourceCount, encoder.chunkSize, input.length);
  const dropped = new Set([2, 7, 11]);
  for (let id = 0; id < encoder.sourceCount; id++) if (!dropped.has(id)) decoder.addSymbol(id, encoder.symbol(id).data);
  for (let id = encoder.sourceCount; id < encoder.sourceCount + 500 && !decoder.complete; id++) decoder.addSymbol(id, encoder.symbol(id).data);
  assert.equal(decoder.complete, true);
  assert.deepEqual(decoder.reconstruct(), input);
});

test('duplicate symbols are ignored safely', () => {
  const input = Uint8Array.from([1, 2, 3, 4]);
  const encoder = new FountainEncoder(input, 4);
  const decoder = new FountainDecoder(1, 4, 4);
  const symbol = encoder.symbol(0);
  assert.equal(decoder.addSymbol(0, symbol.data), true);
  assert.equal(decoder.addSymbol(0, symbol.data), false);
  assert.deepEqual(decoder.reconstruct(), input);
});
