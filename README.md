# qcolortrasfer

**Experimental offline file transfer through animated colored optical frames.**

qcolortrasfer is a free, open-source web app that transfers files from one screen to another device's camera without Wi-Fi, Bluetooth, accounts or a backend server.

The current v0.1 baseline is intentionally conservative: four data colors encode 2 bits per cell, while an original LT-style systematic fountain layer tolerates dropped optical frames. Each frame has CRC32 validation and the reconstructed file is SHA-256 checked when Web Crypto is available.

> Status: experimental proof of concept. Do not use it as the only copy of important data.

## How it works

```text
File
  -> source chunks
  -> systematic + repair fountain symbols
  -> optical packet + CRC32
  -> 4-color matrix animation
  -> camera
  -> per-frame color decode + CRC32
  -> fountain peeling decoder
  -> reconstructed file + SHA-256 check
```

The optical layer and fountain layer are deliberately independent so future versions can test 2/4/8 colors, color+shape modulation, stronger ECC, perspective correction and alternative fountain backends without changing the whole application.

## Run locally

No build step is required. Serve the repository over HTTP/HTTPS; camera access usually requires HTTPS or `localhost`.

```bash
python -m http.server 8080
```

Then open `http://localhost:8080`.

## Tests

```bash
npm test
```

## GitHub Pages

The application is static and can be published directly from the repository root with GitHub Pages. Camera APIs require HTTPS, which GitHub Pages provides.

## License and attribution

qcolortrasfer is MIT licensed. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

The project is inspired by:

- Decimen Optical Transfer
- libcimbar
- Wirehair

The current baseline does **not** incorporate AGPL-licensed Decimen source, MPL-licensed libcimbar source, or Wirehair source. See the notices file for provenance rules.
