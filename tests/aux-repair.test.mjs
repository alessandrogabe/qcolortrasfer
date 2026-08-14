import test from 'node:test';
import assert from 'node:assert/strict';
import { AuxRepairAssembler, decodeAuxRepairPacket, encodeAuxRepairPacket, AUX_MAGIC } from '../js/aux-repair.js';
import { FountainEncoder, FountainDecoder } from '../js/fountain.js';

test('QAR1 roundtrip carries one CRC-protected systematic stripe', () => {
  const block = Uint8Array.from({ length: 1000 }, (_, i) => (i * 29 + 7) & 255);
  const meta = { auxSessionId: 0x12345678, sourceCount: 3, chunkSize: 1000, containerLength: 2991, stripeSize: 512 };
  const packet = encodeAuxRepairPacket(meta, 1, 0, block);
  const decoded = decodeAuxRepairPacket(packet);
  assert.equal(new DataView(packet.buffer, packet.byteOffset, packet.byteLength).getUint32(0), AUX_MAGIC);
  assert.equal(decoded.auxSessionId, meta.auxSessionId);
  assert.equal(decoded.blockIndex, 1);
  assert.equal(decoded.stripeIndex, 0);
  assert.equal(decoded.stripeCount, 2);
  assert.equal(decoded.payload.length, 512);
  assert.deepEqual(decoded.payload, block.subarray(0, 512));
});

test('AUX assembler accepts out-of-order stripes and emits exact padded source block once', () => {
  const block = Uint8Array.from({ length: 1000 }, (_, i) => (i * 17 + 3) & 255);
  const meta = { auxSessionId: 99, sourceCount: 4, chunkSize: 1000, containerLength: 3500, stripeSize: 512 };
  const p0 = encodeAuxRepairPacket(meta, 2, 0, block);
  const p1 = encodeAuxRepairPacket(meta, 2, 1, block);
  const assembler = new AuxRepairAssembler();
  assert.equal(assembler.add(p1), null);
  assert.equal(assembler.add(p1), null);
  const done = assembler.add(p0);
  assert.ok(done);
  assert.equal(done.blockIndex, 2);
  assert.deepEqual(done.block, block);
  assert.equal(assembler.blocksCompleted, 1);
  assert.equal(assembler.packetsDup, 1);
  assert.equal(assembler.add(p0), null);
});

test('injecting one systematic source block can trigger LT peeling of a pending equation', () => {
  const chunkSize = 128;
  const bytes = Uint8Array.from({ length: chunkSize * 2 }, (_, i) => (i * 11 + 5) & 255);
  const encoder = new FountainEncoder(bytes, chunkSize, 0x55aa);
  const decoder = new FountainDecoder(encoder.sourceCount, chunkSize, bytes.length, 0x55aa);
  let degreeTwo = null;
  for (let id = 0; id < 5000; id++) {
    const symbol = encoder.symbol(id);
    if (symbol.indices.length === 2) { degreeTwo = symbol; break; }
  }
  assert.ok(degreeTwo, 'expected a degree-2 fountain symbol');
  decoder.addSymbol(degreeTwo.symbolId, degreeTwo.data);
  assert.equal(decoder.solvedCount, 0);
  const injectedBlock = degreeTwo.indices[0];
  assert.equal(decoder.injectSourceBlock(injectedBlock, encoder.sourceBlock(injectedBlock)), true);
  assert.equal(decoder.solvedCount, 2, 'one AUX source block should peel the second block from the pending equation');
  assert.equal(decoder.complete, true);
  assert.deepEqual(decoder.reconstruct(), bytes);
});
