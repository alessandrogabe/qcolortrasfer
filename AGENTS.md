# Project rules

## Principles
- Keep the project free and open source under the MIT License.
- Do not incorporate AGPL/GPL/MPL source code into MIT files.
- Preserve attribution and provenance in `THIRD_PARTY_NOTICES.md`.
- Prefer compatible patches over rewrites.
- Do not remove existing features without an explicit decision recorded in `SPEC.md`.
- The app must remain usable as a static web app with no mandatory server.
- File content must never leave the local device through an application network request.
- Do not add analytics, trackers or external runtime dependencies without an explicit decision.

## Protocol
- Protocol changes require a version bump or backwards-compatible parser.
- Never accept corrupted payloads silently.
- Optical modulation and fountain coding are separate layers.
- Duplicate fountain symbols must be safe.
- Do not describe experimental algorithms as Wirehair/RaptorQ unless they actually are.
- Preserve mid-stream receiver initialization.

## PWA
- Paths must work under a GitHub Pages project subpath.
- Rotate service-worker cache version when cached assets change materially.
- Camera access must remain user-initiated.

## Tests
- Run `npm test` before and after protocol/fountain/PWA changes.
- Add deterministic tests for decoder regressions.
- Run `node --check` on JavaScript/service-worker files.
- Validate `manifest.webmanifest` as JSON.
- A task is not complete if tests fail.

## Documentation
- Update `README.md` for user-visible behavior.
- Update `SPEC.md` for protocol/architecture decisions.
- Update `THIRD_PARTY_NOTICES.md` before incorporating third-party source.

## UI
- Simple, professional, mobile-first interface.
- No unnecessary decorative animations outside the optical transmitter.
- Status, errors, transfer progress and integrity state must be explicit.
- Keep a technical diagnostic log available in the UI.
