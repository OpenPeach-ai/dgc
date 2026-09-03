"""Private, dependency-free terminal diversions used by the hidden ``/bored`` route.

The games deliberately own no terminal, process, filesystem, network, or model resources.  The
prompt_toolkit application remains the sole renderer/input owner, so agent output can continue
streaming while a game is visible.
"""
from .base import BoredController, GameChoice, GameFrame, Segment, game_choices

__all__ = ["BoredController", "GameChoice", "GameFrame", "Segment", "game_choices"]
