# Contract v1 fixtures

These are synthetic, redacted wire-shape fixtures: DSH Connection examples are source-verified against installed DSH 0.1.7-rc.2; `pair-*` and `info-*` pin the dsh-remote access schema. They are not captures from a live Host. The deterministic pairing token is test data only. `contract-v1.json` and every JSON fixture are duplicated byte-for-byte in dsh-mobile so both implementations consume one contract ID and identical samples.

The binary cases store an edge-case byte vector as hex beside the official Connection metadata shape or raw-upload request; they are not hand-authored multipart bodies with fake boundaries. The production plugin carrier has passed an isolated macOS DSH Host round-trip for pairing/info, workspace/session creation, multipart `readBytes`, raw upload, and two `$events` streams with isolated cancellation. That evidence is documented separately and does not imply iOS device, Windows, Linux, approval waterfall, or load compatibility. No user prompt, host path, or real session data is present here.

Run the fixture-shape checks with `node --test test/contract-v1.test.mjs`. These tests validate only the committed examples; run `test/run-m0-host-probe.sh` for the isolated real-Host checks.
