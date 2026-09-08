# Updating DGC and resolving protocol mismatches

The CLI and editor extension are separate installations with independent version numbers. Update
both for the current feature set: CLI 0.29.2 and extension 0.16.2 use editor protocol v6. Additive
capabilities let the extension explain a missing backend feature instead of sending unsupported
commands to an older protocol-v6 CLI.

See [Controls during a turn](LIVE_CONTROLS.md) for live skills, permission changes, steering and queuing.

1. Run `dgc --version` and `dgc protocol describe` in the editor's terminal. Check **User Settings →
   DGC: Command** if the extension uses a different executable. For SSH, containers or WSL, check
   the installation on the machine where the extension runs.
2. Run `dgc update` to update the CLI, or use **DGC: Update CLI to Latest**.
3. Update DGC from your editor's extension catalog. Check the version displayed on DGC's detail page.
   A manual VSIX install can leave that extension pinned: enable **Auto Update** for DGC itself,
   even when the editor's global auto-update setting is enabled.
4. Reload the editor after an extension update if the old code is still active. Use **DGC: Restart
   Backend** after updating the CLI or changing its executable.

`extension requires v5, backend offered v6` means an older extension is running against a newer
CLI. Update and reload the extension. The reverse means the CLI needs updating. Do not edit the
protocol number in installed files or remove the handshake check: the two implementations must
actually understand the same contract.

Cursor uses its own extension catalog, which can show a version later than its public publication.
If the current release is missing there, the [DGC editor page](https://vibedgc.com/vscode) provides a
VSIX and checksum. Install it in the intended local or remote extension host, then re-enable DGC's
individual auto-update setting. A current gallery listing does not prove every running editor has
already downloaded or activated that version.

For background on update controls and Cursor's catalog, see the
[VS Code extension guide](https://code.visualstudio.com/docs/configure/extensions/extension-marketplace)
and [Cursor extension guide](https://prod.cursor.com/help/customization/extensions).
