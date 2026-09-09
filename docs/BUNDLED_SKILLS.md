# Bundled skills

DGC includes 22 reusable instruction packages. They work through the same skill catalog in the
classic CLI, terminal UI and editor. Type `$` or `/` anywhere after a whitespace boundary to choose
one without losing the rest of the draft. The editor attaches a removable chip; terminal clients
insert `$name`. `/skills` opens management and `dgc skills show NAME` prints a package's instructions.

| Skill | Useful request |
| --- | --- |
| `browser-test` | Exercise a browser flow, including failures and recovery, using the project's automation setup. |
| `fix-ci` | Diagnose a failed CI job at its actual commit and verify a scoped fix. |
| `pr-feedback` | Evaluate review comments against current code and address justified changes. |
| `skill-author` | Create or revise a focused, portable skill with tested supporting resources. |
| `mcp-builder` | Develop an MCP server and test the capabilities it actually advertises. |
| `batch` | Divide repetitive work into independent units, with delegation when available and authorized. |
| `code-review` | Review actual changed code for concrete correctness defects. |
| `dataviz` | Choose and implement an understandable chart for the data relationship. |
| `debug` | Trace a failure using discriminating evidence and verify its cause. |
| `deep-research` | Read primary sources and synthesize a cited answer with evidence limits. |
| `dgc-design` | Build a responsive frontend using the requested design and the project's components. |
| `handoff` | Save the objective, current work, checks and remaining steps for continuation. |
| `loop` | Complete an explicit convergence task through verified changes. |
| `onboard` | Explain an unfamiliar repository's real entry points, layout and commands. |
| `plan` | Prepare an evidence-based implementation plan and respect the current execution mode. |
| `refactor` | Restructure code while preserving its intended behavior and existing work. |
| `security-review` | Trace relevant trust boundaries to evidenced security findings. |
| `setup` | Diagnose DGC's native provider, subscription CLI, editor or permission configuration. |
| `ship` | Prepare authorized commits, pushes or PRs from reviewed changes. |
| `ui-review` | Review real interface behavior, responsiveness and reference fidelity. |
| `verify` | Exercise the affected runtime boundary and report observed results. |
| `write-tests` | Add checks for meaningful contracts and regressions. |

For example, enter `Check failed-save recovery $browser-test` or attach **Browser testing** to an
existing editor draft. `Address review comments $pr-feedback` provides the workflow; it does not
authorize posting replies or merging a PR unless those actions were requested. `Create a project API
migration skill $skill-author` creates the package within the requested scope.

Skills provide instructions, not extra tools or service access. Browser testing needs a usable
browser harness; CI/PR inspection needs the relevant client and account access; MCP server development
uses the project's SDK. Missing capabilities are reported explicitly. No skill silently installs a
browser, signs into an account, changes permission mode or launches an external service. Native turns
use DGC's tools; subscription turns receive the selected instructions but use their vendor CLI's
tools and execution boundary. Up to eight explicit skills/templates share a bounded input allowance.

Adaptive discovery uses narrow task signals, while explicit `$name` selection loads exact instructions.
Use **Disable** to remove a package from selection without deleting it; project/user packages can
override a bundled name. Portable `.agents/skills` locations and optional `agents/openai.yaml` labels
are supported. Create/install/reload behavior and metadata are also described in the in-app Skills guide.

The bundled-skill audit removed broad shell-permission recommendations, secret-value command searches,
instructions to weaken tests until they pass, repeated approval gates outside plan mode, and mandatory
DGC styling for other products. `dgc-design` preserves the requested brand/theme; its purple palette is
for DGC-branded or otherwise unbranded standalone DGC artifacts. It uses existing/local fonts and
checks actual contrast rather than assuming a palette is accessible in every use.
