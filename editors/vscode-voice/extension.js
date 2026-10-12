'use strict';
// DGC Voice: records the microphone on the computer you're at, for DGC.
//
// DGC's own extension runs where DGC runs: on the remote machine, in a Remote SSH window. A microphone is on the
// computer in front of you, and an editor's webviews can't use it. So this small extension runs on that computer
// (extensionKind "ui") and offers the commands DGC calls across the connection: dgcVoice.status, dgcVoice.start,
// dgcVoice.level (how loud it is, for the waveform), dgcVoice.stop (the recording, as base64 16-bit mono PCM at
// 16 kHz) and dgcVoice.cancel. It records nothing until
// DGC asks, keeps nothing after it hands the recording over, and sends it nowhere else.

const vscode = require('vscode');
const { Recorder } = require('./recording');

function activate(context) {
    const recorder = new Recorder({ scripts: context.asAbsolutePath('recorders') });
    context.subscriptions.push(
        vscode.commands.registerCommand('dgcVoice.status', () => recorder.status()),
        vscode.commands.registerCommand('dgcVoice.start', () => recorder.start()),
        vscode.commands.registerCommand('dgcVoice.stop', () => recorder.stop()),
        vscode.commands.registerCommand('dgcVoice.cancel', () => recorder.cancel()),
        vscode.commands.registerCommand('dgcVoice.level', () => recorder.levels()),
        { dispose: () => recorder.cancel() },
    );
}

function deactivate() {}

module.exports = { activate, deactivate };
