"""Voice in DGC: dictation and reading aloud with models the user installs (Settings -> Voice models).

catalog.py lists the models; manager.py installs and runs them (in worker.py, on the voice runtime's own Python);
service.py is `dgc serve`'s voice_* commands. Recording happens where the microphone is: in the editor, a small
companion extension on the user's own computer records and sends the audio here.
"""
