// qcolortrasfer v2 transmitter raster worker.
// Dense QR generation is CPU-heavy. Keep B/W, 4-state and 8-state raster work
// off the UI/rAF thread so painting can follow display cadence while future
// frames are prepared in parallel.

import { createQrRaster, createDualQrRaster, createTripleQrRaster } from './optical.js';

self.onmessage = async event => {
  const { id, generation, visualStates = 4, packets = [] } = event.data || {};
  try {
    const arrays = packets.map(buffer => new Uint8Array(buffer));
    const expected = visualStates === 8 ? 3 : visualStates === 2 ? 1 : 2;
    if (arrays.length !== expected) throw new Error(`TX worker expects ${expected} packet(s) for visualStates=${visualStates}`);
    const started = performance.now();
    const raster = visualStates === 8
      ? await createTripleQrRaster(arrays[0], arrays[1], arrays[2])
      : visualStates === 2
        ? await createQrRaster(arrays[0])
        : await createDualQrRaster(arrays[0], arrays[1]);
    const generationMs = performance.now() - started;
    self.postMessage({
      id, generation, generationMs,
      raster: {
        size: raster.size, version: raster.version, modules: raster.modules,
        totalModules: raster.totalModules, ecc: raster.ecc,
        visualStates: raster.visualStates, channels: raster.channels,
        coloredModules: raster.coloredModules, colorMode: raster.colorMode,
        pixels: raster.pixels.buffer
      },
      error: null
    }, [raster.pixels.buffer]);
  } catch (error) {
    self.postMessage({ id, generation, raster: null, generationMs: 0, error: error?.message || String(error) });
  }
};

self.postMessage({ id: -1, ready: true, error: null });
