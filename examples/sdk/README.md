# SDK examples

Each script runs against an installed SDK and a DGC CLI install. Set the model and endpoint, and
point `DGC_PYTHON` at the CLI's Python:

```bash
python3 -m pip install dgc-sdk==0.5.3
export DGC_PYTHON="$(dirname "$(readlink -f "$(command -v dgc)")")/python"
export DGC_MODEL=qwen3:8b DGC_BASE_URL=http://127.0.0.1:11434/v1   # any OpenAI-compatible endpoint
# export DGC_API_KEY=...   when the endpoint needs a key

python3 hello_run.py /path/to/workspace       # one read-only question
python3 app_session.py /path/to/workspace     # stream events as they arrive
python3 resume_run.py /path/to/workspace      # close a session, resume it by id
python3 ci_review.py /path/to/checkout        # read-only review, JSON report, exit code
python3 ci_edit.py /path/to/checkout --patch fix.patch   # edits only, then a git-apply-able patch
node hello_run.mjs /path/to/workspace         # Node 22+, after npm install of the SDK tarball
python3 workbench.py --workspace /path/to/workspace --mock   # browser workbench, scripted model
```

Every script also takes `--model`, `--base-url` and `--state-dir` (default: a new temporary
directory). From a DGC checkout without installing, prefix the Python commands with
`PYTHONPATH=sdk/python:.` and run `node --experimental-strip-types examples/sdk/hello_run.mjs`.

CI recipes print JSON. Exit codes: 0 accepted, 1 rejected, 2 usage, 3 blocked, 4 timeout,
5 failed. `ci_edit.py` needs a clean git checkout; its patch is `git diff` against HEAD, new files
included.

`workbench.py` binds 127.0.0.1 and prints a URL with a one-time token
(`http://127.0.0.1:8765/#token=...`). Its API accepts only that token, JSON bodies and requests from
its own page, so other machines and other websites cannot start runs or approve tools. `--host`
exposes it to the network; do that only on a network you trust.
