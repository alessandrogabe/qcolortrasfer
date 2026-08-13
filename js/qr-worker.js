// Portable QR decoder worker. Decimen v0.3.0 uses the same core approach:
// full camera frames -> worker pool -> zxing-cpp compiled to WebAssembly.

const ZXING_MODULE_URL = 'https://esm.sh/zxing-wasm@2.0.0/reader?bundle';
const ZXING_WASM_URL = 'https://cdn.jsdelivr.net/npm/zxing-wasm@2.0.0/dist/reader/zxing_reader.wasm';

let readerPromise = null;

async function getReader() {
  if (!readerPromise) {
    readerPromise = (async () => {
      const mod = await import(ZXING_MODULE_URL);
      mod.prepareZXingModule({
        overrides: {
          locateFile(path, prefix) {
            return path.endsWith('.wasm') ? ZXING_WASM_URL : prefix + path;
          },
        },
      });
      await mod.readBarcodes(new ImageData(8, 8), { formats: ['QRCode'], maxNumberOfSymbols: 1 })
        .catch(() => undefined);
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
    const results = await reader.readBarcodes(image, { formats: ['QRCode'], maxNumberOfSymbols: 1 });
    const result = results.find(item => item.isValid && item.bytes?.length > 0);
    self.postMessage({ id, bytes: result ? result.bytes : null, error: null });
  } catch (error) {
    self.postMessage({ id, bytes: null, error: error?.message || String(error) });
  }
};

void getReader().then(() => self.postMessage({ id: -1, ready: true, bytes: null, error: null }))
  .catch(error => self.postMessage({ id: -1, ready: false, bytes: null, error: error?.message || String(error) }));
