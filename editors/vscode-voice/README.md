# DGC Voice

Lets [DGC](https://vibedgc.com) take dictation. It records your microphone on the computer you're sitting at, even when DGC itself runs on another machine over Remote SSH.

You don't use DGC Voice directly. Press the microphone in a DGC chat and DGC asks it to record. Press it again and DGC Voice hands the recording back, and the speech model you chose in DGC's **Settings → Voice** writes down what you said.

- **It records only when you ask.** Nothing runs until you press the microphone, and Esc cancels.
- **It shows that it hears you.** While it records, DGC draws a waveform from how loud your microphone is.
- **It keeps nothing.** The recording is deleted once it is handed back to DGC, and it is never sent anywhere else.
- **It needs nothing extra.**
  - macOS uses Apple's own audio recorder.
  - Windows uses the Windows audio API.
  - Linux uses `arecord` (alsa-utils), PipeWire's `pw-record` or PulseAudio's `parecord`, whichever you have.

The first time you dictate on a Mac, macOS asks whether your editor may use the microphone. If you said no, allow it in **System Settings → Privacy & Security → Microphone**.
