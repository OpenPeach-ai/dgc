---
name: write-tests
description: Author tests for code that has none — pin the contract, match the project's existing framework, and write the fewest tests that catch real breakage. Use when code needs test coverage written, not run or fixed.
---
Write tests for code that lacks them. Target (optional): $ARGUMENTS

Do not invent a framework, do not chase a coverage percentage. Pin the contract, match what the project already uses, and write the fewest tests that would actually catch a regression.

1. Pin the contract. read_file the target, then grep for its callers to see how it is really invoked. Write down the inputs it accepts, the outputs/return shape it promises, the side-effects it performs (writes, network, state), and the errors it is supposed to raise. That list — not the implementation lines — is what you will test.

2. Find the existing test setup and MATCH it. grep for the project's framework and conventions (e.g. `*.test.*`/`*_test.*`/`test_*`, `describe`/`it`, `pytest`, `go test`, `#[test]`) and read one nearby test file. Reuse its runner, imports, assertion style, fixtures/mocks, and file naming. Never introduce a new test framework or dependency.

3. Pick the level by risk: pure logic → a unit test; a boundary crossing (DB, HTTP, filesystem) → an integration test with the project's existing fixtures/mocks; a real user flow → an e2e test. Choose the lowest level that still exercises the contract.

4. write_file (or edit_file into an existing test file) the tests: one for the happy path, plus the edges that actually break code — empty/null/missing input, min/max boundaries, and each error path from step 1. Skip trivial getters and combinations that add no new signal.

5. Run them with bash using the project's test command and READ the output. Every new test must PASS. Fix your test (not the code under test) until it does.

6. Prove a test isn't vacuous: edit_file to break the code under test in one spot, rerun with bash, confirm a test now FAILS, then revert the mutation exactly and rerun to confirm green again.

7. Report which contract points from step 1 are now covered and which you left untested and why. Report coverage by behavior, never as a percentage.

Rules:
- Test behavior through the public interface, never private internals or exact log strings.
- Match the existing framework and file layout exactly; add no new dependency.
- Leave the code under test unchanged — the only edit you keep is the test file.
- A test that never fails is worthless: if the mutation in step 6 didn't turn something red, the test is wrong.
