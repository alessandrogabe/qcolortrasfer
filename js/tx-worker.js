// qcolortrasfer v2 transmitter raster worker.
// Dense QR generation is CPU-heavy, and 4-state modulation needs two ordinary
// QR matrices for every physical tile. Keep that work off the UI/rAF thread so
// painting can follow display cadence even while the next frames are prepared.

import { createDualQrRaster, createTripleQrRaster } from './optical.js';

self.onmessage = async event => {
  const { id, generation, visualStates = 4, packets = [] } = event.data || {};
  try {
    const arrays = packets.map(buffer => new Uint8Array(buffer));
    if (visualStates === 8 && arrays.length !== 3) throw new Error('8-state TX worker expects 3 packets');
    if (visualStates !== 8 && arrays.length !== 2) throw new Error('4-state TX worker expects 2 packets');
    const started = performance.now();
    const raster = visualStates === 8
      ? await createTripleQrRaster(arrays[0], arrays[1], arrays[2])
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
