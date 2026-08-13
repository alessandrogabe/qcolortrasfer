// Portable multi-QR decoder worker. The acquisition architecture follows
// Decimen Optical Transfer v0.3.0 (MIT): full camera frame -> worker ->
// zxing-cpp/WASM. qcolortrasfer asks ZXing for every visible QR in the frame.

const ZXING_MODULE_URL = 'https://esm.sh/zxing-wasm@2.0.0/reader?bundle';
const ZXING_WASM_URL = 'https://cdn.jsdelivr.net/npm/zxing-wasm@2.0.0/dist/reader/zxing_reader.wasm';
const MAX_SYMBOLS = 8;
let readerPromise = null;

async function getReader() {
  if (!readerPromise) {
    readerPromise = (async () => {
      const mod = await import(ZXING_MODULE_URL);
      mod.prepareZXingModule({ overrides: { locateFile(path, prefix) { return path.endsWith('.wasm') ? ZXING_WASM_URL : prefix + path; } } });
      await mod.readBarcodes(new ImageData(8, 8), { formats: ['QRCode'], maxNumberOfSymbols: 1 }).catch(() => undefined);
      return mod;
    })();
  }
  return readerPromise;
}

self.onmessage = async event => {
  const { id, buf, w, h } = event.data;
  try {
    const reader = await getReader();
    const image = new ImageData(new Uint8ClampedArray(buf), w, h);
    const results = await reader.readBarcodes(image, { formats: ['QRCode'], maxNumberOfSymbols: MAX_SYMBOLS });
    const symbols = results.filter(item => item.isValid && item.bytes?.length > 0).map(item => item.bytes);
    self.postMessage({ id, symbols, error: null });
  } catch (error) {
    self.postMessage({ id, symbols: [], error: error?.message || String(error) });
  }
};

void getReader().then(() => self.postMessage({ id: -1, ready: true, symbols: [], error: null }))
  .catch(error => self.postMessage({ id: -1, ready: false, symbols: [], error: error?.message || String(error) }));
