# SDK conformance fixtures

Named scenarios both Python `tests/test_dgc_sdk.py` and Node `tests/test_dgc_sdk_ts.mjs`
must keep covering against real `dgc serve`:

| Scenario | Python | Node |
| --- | --- | --- |
| Isolation / host `~/.dgc` unchanged | yes | (via custom-tool / schema runs) |
| `run` + `stream` share a result | yes | schema run |
| One active run per session | yes | — |
| Native picker / `on_question` | yes | — |
| Permission deny / once / timeout / throw | yes | — |
| Custom host tool | yes | yes |
| Tool handler timeout | yes | — |
| `outputSchema` harness validation | yes | yes |
| Resume / fork / checkpoints | yes | — |
| Cancel drain + reuse | yes | — |
| Async Python stream | yes | n/a |
| Close reaps `dgc serve` | yes | — |
| Required sandbox fails closed | yes | — |

Mock OpenAI server lives in the test modules (and `examples/sdk/workbench.py --mock`).
