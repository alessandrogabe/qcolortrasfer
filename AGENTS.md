# Project rules

## Principles

- Keep the project free and open source under the MIT License.
- Do not incorporate AGPL/GPL/MPL source code into MIT files.
- Preserve attribution and provenance in `THIRD_PARTY_NOTICES.md`.
- Prefer small compatible patches over rewrites.
- Do not remove existing features without an explicit decision recorded in `SPEC.md`.
- The app must remain usable as a static web app with no mandatory server.
- File content must never leave the local device through a network request.

## Protocol

- Protocol changes require a version bump or backwards-compatible parser.
- Never accept corrupted payloads silently: CRC/integrity checks are mandatory.
- Optical modulation and fountain coding are separate layers.
- The receiver must ignore duplicate fountain symbols safely.
- Experimental algorithms must be labeled as experimental and not described as Wirehair/RaptorQ unless they actually are.

## Tests

- Run `npm test` before and after protocol/fountain changes.
- Add deterministic tests for every decoder regression.
- A task is not complete if tests fail.

## Documentation

- Update `README.md` for user-visible behavior.
- Update `SPEC.md` for protocol/architecture decisions.
- Update `THIRD_PARTY_NOTICES.md` before incorporating any third-party source.

## UI

- Simple, utilitarian, mobile-first interface.
- No unnecessary animations outside the optical transmitter.
- Status, errors, transfer progress and integrity state must be explicit.
