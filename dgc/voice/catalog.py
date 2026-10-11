"""The voice models DGC offers in Settings -> Voice models, and the runtime they run on.

Nothing here is bundled: each model is downloaded when the user installs it, from sherpa-onnx's own releases, and
checked against the SHA-256 GitHub publishes for it. The runtime (sherpa-onnx, Apache-2.0) goes into a small
environment of its own the first time any model is installed. Sizes are the downloads'; each model says its licence,
because they differ.
"""

from __future__ import annotations

RELEASES = "https://github.com/k2-fsa/sherpa-onnx/releases/download"

# The runtime: one engine for dictation and reading aloud, on Linux, macOS and Windows (x64 and arm64).
RUNTIME = {"packages": ["sherpa-onnx==1.13.8", "numpy>=1.26,<3"], "size_mb": 50}

MODELS: list[dict] = [
    {
        "id": "moonshine-base-en", "role": "dictation", "name": "Moonshine", "summary": "Fast. English only.",
        "languages": "English", "licence": "MIT", "size": 111_266_225,
        "url": f"{RELEASES}/asr-models/sherpa-onnx-moonshine-base-en-quantized-2026-02-27.tar.bz2",
        "sha256": "43232c1d13013d37317163baec3135bd771a186a4356f28c889bab453bb0e891",
        "folder": "sherpa-onnx-moonshine-base-en-quantized-2026-02-27", "engine": "moonshine_v2",
        "files": {"encoder": "encoder_model.ort", "decoder": "decoder_model_merged.ort", "tokens": "tokens.txt"},
    },
    {
        "id": "nemotron-3.5-asr", "role": "dictation", "name": "Nemotron 3.5",
        "summary": "Most accurate. 40 languages, found by itself.", "languages": "40 languages",
        "licence": "NVIDIA Open Model (OpenMDW-1.1)", "size": 475_271_763,
        "url": f"{RELEASES}/asr-models/sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-560ms-int8-2026-06-11.tar.bz2",
        "sha256": "c6bf5e0df765f9d5b43bc9e0536d4b4b3e7d40bdf5ecf13e45f134c51c05ae3a",
        "folder": "sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-560ms-int8-2026-06-11", "engine": "nemotron",
        "files": {"encoder": "encoder.int8.onnx", "decoder": "decoder.int8.onnx", "joiner": "joiner.int8.onnx",
                  "tokens": "tokens.txt"},
    },
    {
        "id": "kitten-mini-en", "role": "read_aloud", "name": "Kitten", "summary": "Small and clear. English.",
        "languages": "English", "licence": "Apache-2.0", "size": 67_547_594,
        "url": f"{RELEASES}/tts-models/kitten-mini-en-v0_8.tar.bz2",
        "sha256": "518f9b130320f690d5b5476df77bde4215fca67773cda16710318e5081234b9d",
        "folder": "kitten-mini-en-v0_8", "engine": "kitten",
        "files": {"model": "model.onnx", "voices": "voices.bin", "tokens": "tokens.txt", "data_dir": "espeak-ng-data"},
    },
    {
        "id": "pocket-tts", "role": "read_aloud", "name": "Pocket TTS", "summary": "Natural. 7 languages.",
        "languages": "7 languages", "licence": "Non-commercial use only", "size": 98_336_520,
        "url": f"{RELEASES}/tts-models/sherpa-onnx-pocket-tts-int8-2026-01-26.tar.bz2",
        "sha256": "2f3b88823cbbb9bf0b2477ec8ae7b3fec417b3a87b6bb5f256dba66f2ad967cb",
        "folder": "sherpa-onnx-pocket-tts-int8-2026-01-26", "engine": "pocket",
        "files": {"lm_flow": "lm_flow.int8.onnx", "lm_main": "lm_main.int8.onnx", "encoder": "encoder.onnx",
                  "decoder": "decoder.int8.onnx", "text_conditioner": "text_conditioner.onnx",
                  "vocab_json": "vocab.json", "token_scores_json": "token_scores.json", "voice": "test_wavs/bria.wav"},
    },
]

ROLES = ("dictation", "read_aloud")


def model(model_id: str) -> dict | None:
    return next((m for m in MODELS if m["id"] == model_id), None)
