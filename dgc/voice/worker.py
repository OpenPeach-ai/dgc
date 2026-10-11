"""DGC's voice worker: run by the voice runtime's own Python (~/.dgc/voice/runtime), never imported by DGC.

It keeps the models it has loaded and answers one JSON line per request on stdin, one or more per answer on stdout
(audio goes through files, so no line is large):

  {"id", "op": "transcribe", "engine", "dir", "files", "pcm": <16-bit mono PCM file>, "rate", "language"}
      -> {"id", "ok": true, "text"}
  {"id", "op": "speak", "engine", "dir", "files", "text": [<sentence>, ...], "out": <folder>}
      -> {"id", "chunk": <16-bit mono PCM file>, "rate"} for each sentence, then {"id", "ok": true}
  {"id", "op": "ping"} -> {"id", "ok": true, "version"}

Only the standard library, numpy and sherpa_onnx: it must not need DGC.
"""

import json
import os
import sys
import wave

loaded = {}


def say(message):
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()


def path(request, name):
    return os.path.join(request["dir"], request["files"][name])


def recognizer(request):
    import sherpa_onnx
    key = (request["engine"], request["dir"])
    if key not in loaded:
        threads = max(1, min(4, os.cpu_count() or 1))
        if request["engine"] == "moonshine_v2":
            loaded[key] = sherpa_onnx.OfflineRecognizer.from_moonshine_v2(
                encoder=path(request, "encoder"), decoder=path(request, "decoder"), tokens=path(request, "tokens"),
                num_threads=threads)
        elif request["engine"] == "nemotron":
            loaded[key] = sherpa_onnx.OnlineRecognizer.from_transducer(
                tokens=path(request, "tokens"), encoder=path(request, "encoder"), decoder=path(request, "decoder"),
                joiner=path(request, "joiner"), num_threads=threads)
        else:
            raise ValueError("not a dictation model: " + request["engine"])
    return loaded[key]


def voice(request):
    import sherpa_onnx
    key = (request["engine"], request["dir"])
    if key not in loaded:
        threads = max(1, min(4, os.cpu_count() or 1))
        if request["engine"] == "kitten":
            model = sherpa_onnx.OfflineTtsModelConfig(kitten=sherpa_onnx.OfflineTtsKittenModelConfig(
                model=path(request, "model"), voices=path(request, "voices"), tokens=path(request, "tokens"),
                data_dir=path(request, "data_dir")), num_threads=threads)
        elif request["engine"] == "pocket":
            files = {k: path(request, k) for k in ("lm_flow", "lm_main", "encoder", "decoder", "text_conditioner",
                                                   "vocab_json", "token_scores_json")}
            model = sherpa_onnx.OfflineTtsModelConfig(pocket=sherpa_onnx.OfflineTtsPocketModelConfig(**files),
                                                      num_threads=threads)
        else:
            raise ValueError("not a read-aloud model: " + request["engine"])
        loaded[key] = sherpa_onnx.OfflineTts(sherpa_onnx.OfflineTtsConfig(model=model))
    return loaded[key]


def transcribe(request):
    import numpy as np
    with open(request["pcm"], "rb") as handle:
        samples = np.frombuffer(handle.read(), dtype=np.int16).astype(np.float32) / 32768.0
    rate = int(request.get("rate") or 16000)
    engine = recognizer(request)
    if request["engine"] == "nemotron":
        stream = engine.create_stream()
        stream.set_option("language", request.get("language") or "auto")
        stream.accept_waveform(rate, samples)
        stream.accept_waveform(rate, np.zeros(int(rate * 0.8), dtype=np.float32))   # lets the last words through
        stream.input_finished()
        while engine.is_ready(stream):
            engine.decode_stream(stream)
        text = engine.get_result(stream)
    else:
        stream = engine.create_stream()
        stream.accept_waveform(rate, samples)
        engine.decode_stream(stream)
        text = stream.result.text
    return " ".join(str(text).split())


def reference(request):
    import numpy as np
    with wave.open(path(request, "voice")) as handle:
        rate, channels = handle.getframerate(), handle.getnchannels()
        raw = np.frombuffer(handle.readframes(handle.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
    return (raw.reshape(-1, channels).mean(axis=1) if channels > 1 else raw), rate


def speak(request):
    import numpy as np
    import sherpa_onnx
    engine = voice(request)
    config = None
    if request["engine"] == "pocket":
        config = sherpa_onnx.GenerationConfig()
        samples, rate = reference(request)
        config.reference_audio = samples.tolist()
        config.reference_sample_rate = rate
    for n, sentence in enumerate(request["text"]):
        audio = engine.generate(sentence, config) if config is not None else engine.generate(sentence, sid=0, speed=1.0)
        pcm = (np.clip(np.asarray(audio.samples, dtype=np.float32), -1, 1) * 32767).astype("<i2").tobytes()
        out = os.path.join(request["out"], f"{n:04d}.pcm")
        with open(out, "wb") as handle:
            handle.write(pcm)
        say({"id": request["id"], "chunk": out, "rate": int(audio.sample_rate)})


def main():
    for line in sys.stdin:
        try:
            request = json.loads(line)
        except ValueError:
            continue
        rid = request.get("id")
        try:
            if request.get("op") == "ping":
                import sherpa_onnx
                say({"id": rid, "ok": True, "version": getattr(sherpa_onnx, "__version__", "")})
            elif request.get("op") == "transcribe":
                say({"id": rid, "ok": True, "text": transcribe(request)})
            elif request.get("op") == "speak":
                speak(request)
                say({"id": rid, "ok": True})
            else:
                say({"id": rid, "ok": False, "error": "unknown request"})
        except Exception as exc:                         # noqa: BLE001 -- reported to DGC, which says so
            say({"id": rid, "ok": False, "error": f"{type(exc).__name__}: {exc}"[:500]})


if __name__ == "__main__":
    main()
