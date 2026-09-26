# Contract v1 fixtures

These are source-verified wire-shape fixtures derived from the installed DSH 0.1.7-rc.2 package. They are intentionally marked as synthetic protocol examples, not captures from a live Host. `contract-v1.json` is duplicated byte-for-byte in dsh-mobile so both implementations consume one contract ID and the same JSON fixtures.

The binary cases store an edge-case byte vector as hex beside the official Connection metadata shape or raw-upload request; they are not hand-authored multipart bodies with fake boundaries. The upload path `/api/session/uploadFileBinary` is source-confirmed, but M0 must add captured, redacted Host round-trip evidence and verify the official adapter before any capability is marked passed. No user prompt, token, host path, or real session data is present here.

Run the fixture-shape checks with `node --test test/contract-v1.test.mjs`. These tests validate only the committed examples; they do not invoke a Host or mark M0 carrier compatibility as passed.
