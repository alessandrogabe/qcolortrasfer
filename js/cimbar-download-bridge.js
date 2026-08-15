// qcolortrasfer libcimbar download bridge (MIT).
//
// libcimbar runs in a same-origin iframe and reconstructs the received file as
// a Blob before calling Zstd.download_blob(name, blob). Safari/iOS may keep that
// download scoped to the iframe. This adapter republishes the exact Blob in the
// qcolortrasfer top-level document without modifying any vendored MPL file.

const $ = id => document.getElementById(id);
let currentUrl = null;
let currentName = '';
let shellButton = null;

function clearDownload() {
  if (currentUrl) {
    try { URL.revokeObjectURL(currentUrl); } catch {}
  }
  currentUrl = null;
  currentName = '';

  const link = $('download');
  if (link) {
    link.hidden = true;
    link.removeAttribute('href');
    link.removeAttribute('download');
    link.textContent = 'Scarica file';
  }
  if (shellButton) shellButton.hidden = true;
}

function ensureShellButton() {
  if (shellButton?.isConnected) return shellButton;
  const shell = $('cimbarEngineShell');
  const bar = shell?.firstElementChild;
  if (!bar) return null;

  shellButton = document.createElement('button');
  shellButton.id = 'cimbarDownloadButton';
  shellButton.type = 'button';
  shellButton.textContent = 'SCARICA';
  shellButton.hidden = true;
  Object.assign(shellButton.style, {
    border: '1px solid #438bca', background: '#0a2032', color: '#8dd0ff',
    padding: '6px 10px', font: 'inherit', fontWeight: '700', whiteSpace: 'nowrap',
  });
  shellButton.addEventListener('click', () => {
    if (!currentUrl) return;
    const a = document.createElement('a');
    a.href = currentUrl;
    a.download = currentName || 'cimbar-received.bin';
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  });

  const exit = [...bar.querySelectorAll('button')].find(button => button.textContent === 'ESCI');
  bar.insertBefore(shellButton, exit || null);
  return shellButton;
}

function publishDownload(name, blob) {
  if (!blob) return;
  clearDownload();

  // Re-wrap in the parent realm so the Blob URL is owned by qcolortrasfer and
  // remains valid after the libcimbar iframe is closed/navigated.
  const parentBlob = new Blob([blob], { type: blob.type || 'application/octet-stream' });
  currentUrl = URL.createObjectURL(parentBlob);
  currentName = String(name || 'cimbar-received.bin');

  const link = $('download');
  if (link) {
    link.href = currentUrl;
    link.download = currentName;
    link.textContent = `SCARICA FILE · ${currentName}`;
    link.hidden = false;
  }

  const button = ensureShellButton();
  if (button) button.hidden = false;

  const status = $('rxStatus');
  if (status && !/SCARICA FILE/.test(status.textContent || '')) {
    status.textContent += ' · SCARICA FILE PRONTO';
    status.dataset.kind = 'ok';
  }
}

async function waitForDownloadApi(w, timeoutMs = 20000) {
  const started = performance.now();
  while (performance.now() - started < timeoutMs) {
    try {
      if (w?.Zstd && typeof w.Zstd.download_blob === 'function') return w.Zstd;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return null;
}

async function bridgeFrame(frame) {
  let w;
  try { w = frame.contentWindow; } catch { return; }
  const zstd = await waitForDownloadApi(w);
  if (!zstd || w.__qcolorCimbarDownloadBridged) return;

  w.__qcolorCimbarDownloadBridged = true;
  const original = zstd.download_blob.bind(zstd);
  zstd.download_blob = function qcolorTopLevelDownload(name, blob) {
    try { publishDownload(name, blob); } catch (error) { console.error('[cimbar-download-bridge]', error); }
    // Preserve the exact upstream behavior too. On browsers where iframe
    // downloads work, this remains backward-compatible; qcolor's link is the
    // reliable top-level fallback and remains available afterwards.
    return original(name, blob);
  };
}

function install() {
  if (typeof document === 'undefined' || typeof window === 'undefined') return;
  const frame = $('cimbarEngineFrame');
  if (!frame) return;

  frame.addEventListener('load', () => {
    let pathname = '';
    try { pathname = frame.contentWindow?.location?.pathname || ''; } catch {}
    if (/\/vendor\/libcimbar\/v0\.6\.7c\/recv\.html$/.test(pathname)) void bridgeFrame(frame);
  });

  document.addEventListener('click', event => {
    const id = event.target?.id;
    const method = $('rxMethod');
    if ((id === 'startRx' || id === 'resetRx') && method?.value === 'cimbar') clearDownload();
  }, true);
}

install();

export { clearDownload, publishDownload };
