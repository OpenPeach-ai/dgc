// DGC Voice on macOS: records the microphone to the .wav named by the first argument -- 16-bit mono PCM at
// 16 kHz -- with Apple's AVAudioRecorder, until a file of the same name plus ".stop" appears (or ten minutes pass).
// Every 50 ms it prints "L <level>" (0..1, from the recorder's own meter) for DGC's waveform.
// Run by `osascript -l JavaScript`, so it needs nothing that a Mac doesn't have. The first time, macOS asks
// whether the editor may use the microphone.
ObjC.import('AVFoundation');
ObjC.import('Foundation');

function run(argv) {
    const out = argv[0];
    if (!out) throw new Error('say where to record');
    const files = $.NSFileManager.defaultManager;
    // The settings' keys are the strings their names say (AVFormatIDKey and so on); kAudioFormatLinearPCM is 'lpcm'.
    const settings = $.NSMutableDictionary.dictionary;
    settings.setObjectForKey($.NSNumber.numberWithUnsignedInt(0x6C70636D), 'AVFormatIDKey');
    settings.setObjectForKey($.NSNumber.numberWithDouble(16000), 'AVSampleRateKey');
    settings.setObjectForKey($.NSNumber.numberWithUnsignedInt(1), 'AVNumberOfChannelsKey');
    settings.setObjectForKey($.NSNumber.numberWithUnsignedInt(16), 'AVLinearPCMBitDepthKey');
    settings.setObjectForKey($.NSNumber.numberWithBool(false), 'AVLinearPCMIsFloatKey');
    settings.setObjectForKey($.NSNumber.numberWithBool(false), 'AVLinearPCMIsBigEndianKey');
    const error = $();
    const recorder = $.AVAudioRecorder.alloc.initWithURLSettingsError($.NSURL.fileURLWithPath(out), settings, error);
    if (recorder.isNil()) {
        throw new Error('could not record: ' + (error.isNil() ? 'no microphone' : ObjC.unwrap(error.localizedDescription)));
    }
    recorder.meteringEnabled = true;                            // before it starts, or the meter reads nothing
    if (!recorder.prepareToRecord || !recorder.record) {
        throw new Error('could not record: no microphone, or no permission to use it');
    }
    // console.log writes to stderr: the levels go to stdout, a line each.
    const stdout = $.NSFileHandle.fileHandleWithStandardOutput;
    const say = (line) => stdout.writeData($.NSString.alloc.initWithUTF8String(line + '\n').dataUsingEncoding($.NSUTF8StringEncoding));
    const stop = out + '.stop';
    const until = Date.now() + 600000;
    while (!files.fileExistsAtPath(stop) && Date.now() < until) {
        delay(0.05);
        recorder.updateMeters;
        const db = recorder.averagePowerForChannel(0);          // dBFS: -160 (nothing) .. 0 (full scale)
        say('L ' + Math.pow(10, Math.max(-160, Math.min(0, db)) / 20).toFixed(5));
    }
    recorder.stop;
    return '';
}
