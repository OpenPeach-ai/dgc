# Updating DGC and resolving protocol mismatches

The CLI and editor extension are separate installations with independent version numbers. Update
both for the current feature set: CLI 0.41.3 and extension 0.26.3 use editor protocol v14 (CLI 0.39.0
and extension 0.24.0 use editor protocol v13). Additive
capabilities let the extension explain a missing backend feature instead of sending unsupported
commands to an older CLI.

See [Controls during a turn](LIVE_CONTROLS.md) for live skills, permission changes, steering and queuing.

1. Run `dgc --version` and `dgc protocol describe` in the editor's terminal. Check **User Settings →
   DGC: Command** if the extension uses a different executable. For SSH, containers or WSL, check
   the installation on the machine where the extension runs.
2. Run `dgc update` to update the CLI, or use **DGC: Update CLI to Latest**. From 0.39.0 each
   version is built in its own directory beside the one you have, and the `dgc` launcher switches
   only once the new build is complete. `dgc update --list` shows the kept versions,
   `dgc update --rollback` returns to the version that was active before the last switch, and
   `dgc update --version X` switches to a kept version. An install in a custom location is updated
   where it is. Editor updates show notification progress and reconnect on success. On failure,
   **Output → DGC update** retains the installer’s explanation. Updates reuse DGC’s supported
   Python interpreter; fresh installs search for Python 3.10+ even when an older system Python
   appears first on PATH.
3. Update DGC from your editor's extension catalog, or run **DGC: Check for Extension Updates**
   (extension 0.25.1+). The command checks vibedgc.com directly and offers a checksum-verified VSIX
   when a newer version is published. Installation requires your **Install Update** selection;
   **Reload Window** activates it. A manual VSIX install can leave gallery auto-updates disabled:
   enable **Auto Update** for DGC itself if you want gallery updates too.
4. Reload the editor after an extension update if the old code is still active. Use **DGC: Restart
   Backend** after updating the CLI or changing its executable.

`the extension speaks editor protocol v13; this CLI speaks v14` means an older extension is running
against a newer CLI: update and reload the extension. The reverse means the CLI needs updating. Do
not edit the protocol number in installed files or remove the handshake check: the two
implementations must actually understand the same contract.

Cursor uses its own extension catalog, which can show a version later than its public publication.
If the current release is missing there, the [DGC editor page](https://vibedgc.com/vscode/) provides a
VSIX and checksum. Install it in the intended local or remote extension host, then re-enable DGC's
individual auto-update setting. A current gallery listing does not prove every running editor has
already downloaded or activated that version.

For background on update controls and Cursor's catalog, see the
[VS Code extension guide](https://code.visualstudio.com/docs/configure/extensions/extension-marketplace)
and [Cursor extension guide](https://prod.cursor.com/help/customization/extensions).

## How paired updates work

DGC currently uses the CLI installed on your machine; it does not bundle a private runtime inside
its extension. Extension 0.26.2 records its minimum CLI version, 0.41.0. If the connected CLI is too
old, the existing automatic CLI recovery installs that specific release, then reconnects. The user
setting `dgc.autoUpdateCli` controls this. A custom executable or unsupported install still needs
its own installation method; DGC never overwrites an arbitrary checkout.

If the CLI speaks a newer protocol, DGC stops the incompatible connection and offers the direct
extension update. The same update check runs at most once a day for both gallery and manual installs,
controlled by the user-level `dgc.checkForUpdates` setting. A workspace cannot enable it. Manual
checks bypass that interval. Downloads stay on vibedgc.com, are size bounded and checksum checked;
failed verification leaves the installed extension unchanged. The editor enforces its installation
policy. Reload is offered, never forced during your work.

A standalone `dgc update` also installs the verified extension into each discovered editor, unless
`DGC_SKIP_EXTENSION=1` is set. Discovery includes commands on PATH and, on macOS, Cursor, VS Code
and VSCodium under `/Applications` or `~/Applications`. Updates initiated inside the extension skip
that additional install, so the active extension is not replaced underneath its own updater.

Older extensions do not have the new direct-update command. For the first recovery, download the
[official VSIX](https://vibedgc.com/vscode/dgc.vsix), run **Extensions: Install from VSIX…** in the
intended editor, and reload. Uninstalling and reinstalling through a delayed Cursor catalog can
fetch the older version again; it does not refresh that catalog's mirror.
