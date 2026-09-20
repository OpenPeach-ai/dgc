# Third-party notices

Code in this repository that is derived from other projects, with the licence it carries and what
was changed. (The VS Code extension has its own notices in
[`editors/vscode/THIRD_PARTY_NOTICES.md`](editors/vscode/THIRD_PARTY_NOTICES.md).)

## macOS Seatbelt policy — `dgc/sandbox_macos.sbpl`

Parts of DGC's `strict-v1` macOS sandbox policy are adapted from the Seatbelt policies of
[openai/codex](https://github.com/openai/codex) — `codex-rs/core/src/seatbelt_base_policy.sbpl`,
`seatbelt_network_policy.sbpl` and `seatbelt_read_only_platform_defaults.sbpl` — which are
licensed under the Apache License, Version 2.0:

    Copyright 2025 OpenAI

    Licensed under the Apache License, Version 2.0 (the "License");
    you may not use this file except in compliance with the License.
    You may obtain a copy of the License at

        http://www.apache.org/licenses/LICENSE-2.0

    Unless required by applicable law or agreed to in writing, software
    distributed under the License is distributed on an "AS IS" BASIS,
    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
    See the License for the specific language governing permissions and
    limitations under the License.

Those files, in turn, credit Chromium's macOS sandbox policies
(`sandbox/policy/mac/common.sb`, `renderer.sb` and `network.sb`).

Reused: the `sysctl-read` allow-list, the pseudo-tty and `/dev` rules, and the list of Mach
services a process needs once network is allowed (DNS, `trustd`/`ocspd` and `SecurityServer`
for TLS).

Changed by DGC:

- deny-by-default with an explicit read-list for the system, instead of reading the whole disk,
  so the user's home folder, `~/.dgc`, an SDK session's state folder and the host's shared
  temporary folders are invisible rather than merely unwritable;
- a private 0700 folder per confined command, used as `HOME`/`TMPDIR`/`TMP`/`TEMP` and removed
  when the command ends;
- the workspace, that temporary folder and any extra read directories are passed as
  `sandbox-exec -D` parameters and referenced with `(param …)`, never spliced into the policy
  text;
- `network-outbound`/`network-inbound` are granted for IP only, so unix sockets stay unreachable
  in both network modes;
- additional denies for `/Library/Keychains`, `/private/var/db/dslocal`, `/private/etc/ssh` and
  the TCC database, and for the `kern.procargs`/`kern.procargs2` sysctls.
