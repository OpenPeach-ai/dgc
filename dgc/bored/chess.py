"""Clean-room two-player terminal chess with complete move legality."""
from __future__ import annotations

from .base import GameFrame
from .drawing import centered, crop_origin


class Chess:
    key = "chess"
    title = "CHESS"
    description = "two-player · legal moves, check, and castling"
    minimum_width = 34
    minimum_height = 8
    _DIRECTIONS = {
        "up": (-1, 0), "w": (-1, 0), "down": (1, 0), "s": (1, 0),
        "left": (0, -1), "a": (0, -1), "right": (0, 1), "d": (0, 1),
    }
    _GLYPHS = {
        "K": "♔", "Q": "♕", "R": "♖", "B": "♗", "N": "♘", "P": "♙",
        "k": "♚", "q": "♛", "r": "♜", "b": "♝", "n": "♞", "p": "♟",
    }

    def __init__(self, *, seed: int | None = None) -> None:
        del seed
        self.restart()

    def restart(self, now: float | None = None) -> None:
        del now
        self.board = [
            list("rnbqkbnr"), list("pppppppp"), list("........"), list("........"),
            list("........"), list("........"), list("PPPPPPPP"), list("RNBQKBNR"),
        ]
        self.turn = "white"
        self.cursor = (6, 4)
        self.selected: tuple[int, int] | None = None
        self.castling = set("KQkq")
        self.en_passant: tuple[int, int] | None = None
        self.halfmoves = 0
        self.over = False
        self.winner = ""
        self.note = ""

    def on_resume(self, now: float) -> None:
        del now

    def tick(self, now: float) -> bool:
        del now
        return False

    @staticmethod
    def _inside(row: int, col: int) -> bool:
        return 0 <= row < 8 and 0 <= col < 8

    @staticmethod
    def _white(piece: str) -> bool:
        return piece != "." and piece.isupper()

    def _mine(self, piece: str, side: str | None = None) -> bool:
        side = side or self.turn
        return piece != "." and self._white(piece) == (side == "white")

    def _attacked(self, square: tuple[int, int], by_side: str, board=None) -> bool:
        board = self.board if board is None else board
        row, col = square
        pawn = "P" if by_side == "white" else "p"
        pawn_direction = -1 if by_side == "white" else 1
        source_row = row - pawn_direction
        for source_col in (col - 1, col + 1):
            if self._inside(source_row, source_col) and board[source_row][source_col] == pawn:
                return True
        knight = "N" if by_side == "white" else "n"
        for dr, dc in ((-2, -1), (-2, 1), (-1, -2), (-1, 2),
                       (1, -2), (1, 2), (2, -1), (2, 1)):
            rr, cc = row + dr, col + dc
            if self._inside(rr, cc) and board[rr][cc] == knight:
                return True
        king = "K" if by_side == "white" else "k"
        for dr in (-1, 0, 1):
            for dc in (-1, 0, 1):
                rr, cc = row + dr, col + dc
                if (dr or dc) and self._inside(rr, cc) and board[rr][cc] == king:
                    return True
        targets = (("RQ" if by_side == "white" else "rq",
                    ((-1, 0), (1, 0), (0, -1), (0, 1))),
                   ("BQ" if by_side == "white" else "bq",
                    ((-1, -1), (-1, 1), (1, -1), (1, 1))))
        for pieces, directions in targets:
            for dr, dc in directions:
                rr, cc = row + dr, col + dc
                while self._inside(rr, cc):
                    if board[rr][cc] != ".":
                        if board[rr][cc] in pieces:
                            return True
                        break
                    rr, cc = rr + dr, cc + dc
        return False

    def _king(self, side: str, board=None) -> tuple[int, int] | None:
        board = self.board if board is None else board
        target = "K" if side == "white" else "k"
        return next(((r, c) for r in range(8) for c in range(8)
                     if board[r][c] == target), None)

    def _in_check(self, side: str, board=None) -> bool:
        king = self._king(side, board)
        other = "black" if side == "white" else "white"
        return king is None or self._attacked(king, other, board)

    def _pseudo(self, source: tuple[int, int], *, castles: bool = True) -> list[tuple[int, int]]:
        row, col = source
        piece = self.board[row][col]
        if piece == ".":
            return []
        side = "white" if piece.isupper() else "black"
        result: list[tuple[int, int]] = []

        def add(rr: int, cc: int) -> bool:
            if not self._inside(rr, cc):
                return False
            target = self.board[rr][cc]
            if target == ".":
                result.append((rr, cc))
                return True
            if not self._mine(target, side) and target.lower() != "k":
                result.append((rr, cc))
            return False

        lower = piece.lower()
        if lower == "p":
            direction = -1 if side == "white" else 1
            start_row = 6 if side == "white" else 1
            if self._inside(row + direction, col) and self.board[row + direction][col] == ".":
                result.append((row + direction, col))
                if row == start_row and self.board[row + 2 * direction][col] == ".":
                    result.append((row + 2 * direction, col))
            for dc in (-1, 1):
                rr, cc = row + direction, col + dc
                if not self._inside(rr, cc):
                    continue
                target = self.board[rr][cc]
                if (target != "." and not self._mine(target, side)
                        and target.lower() != "k") or (rr, cc) == self.en_passant:
                    result.append((rr, cc))
        elif lower == "n":
            for dr, dc in ((-2, -1), (-2, 1), (-1, -2), (-1, 2),
                           (1, -2), (1, 2), (2, -1), (2, 1)):
                add(row + dr, col + dc)
        elif lower in ("b", "r", "q"):
            directions = []
            if lower in ("b", "q"):
                directions += [(-1, -1), (-1, 1), (1, -1), (1, 1)]
            if lower in ("r", "q"):
                directions += [(-1, 0), (1, 0), (0, -1), (0, 1)]
            for dr, dc in directions:
                rr, cc = row + dr, col + dc
                while add(rr, cc):
                    rr, cc = rr + dr, cc + dc
        elif lower == "k":
            for dr in (-1, 0, 1):
                for dc in (-1, 0, 1):
                    if dr or dc:
                        add(row + dr, col + dc)
            if castles and not self._in_check(side):
                rights = ("K", "Q") if side == "white" else ("k", "q")
                home = 7 if side == "white" else 0
                other = "black" if side == "white" else "white"
                rook = "R" if side == "white" else "r"
                if (rights[0] in self.castling and row == home and col == 4
                        and self.board[home][5:7] == [".", "."]
                        and self.board[home][7] == rook
                        and not self._attacked((home, 5), other)
                        and not self._attacked((home, 6), other)):
                    result.append((home, 6))
                if (rights[1] in self.castling and row == home and col == 4
                        and self.board[home][1:4] == [".", ".", "."]
                        and self.board[home][0] == rook
                        and not self._attacked((home, 3), other)
                        and not self._attacked((home, 2), other)):
                    result.append((home, 2))
        return result

    @staticmethod
    def _move_on(board, source: tuple[int, int], target: tuple[int, int],
                 en_passant: tuple[int, int] | None) -> None:
        sr, sc = source
        tr, tc = target
        piece = board[sr][sc]
        if piece.lower() == "p" and target == en_passant and board[tr][tc] == ".":
            board[sr][tc] = "."
        board[tr][tc], board[sr][sc] = piece, "."
        if piece.lower() == "k" and abs(tc - sc) == 2:
            rook_from = 7 if tc == 6 else 0
            rook_to = 5 if tc == 6 else 3
            board[tr][rook_to], board[tr][rook_from] = board[tr][rook_from], "."
        if piece == "P" and tr == 0:
            board[tr][tc] = "Q"
        elif piece == "p" and tr == 7:
            board[tr][tc] = "q"

    def legal_moves(self, source: tuple[int, int]) -> list[tuple[int, int]]:
        row, col = source
        piece = self.board[row][col]
        if not self._mine(piece):
            return []
        result = []
        for target in self._pseudo(source):
            trial = [line[:] for line in self.board]
            self._move_on(trial, source, target, self.en_passant)
            if not self._in_check(self.turn, trial):
                result.append(target)
        return result

    def _all_legal(self, side: str) -> bool:
        saved = self.turn
        self.turn = side
        try:
            return any(self.legal_moves((r, c)) for r in range(8) for c in range(8)
                       if self._mine(self.board[r][c], side))
        finally:
            self.turn = saved

    def _move(self, source: tuple[int, int], target: tuple[int, int]) -> None:
        sr, sc = source
        tr, tc = target
        piece = self.board[sr][sc]
        captured = self.board[tr][tc]
        if piece == "K":
            self.castling.difference_update("KQ")
        elif piece == "k":
            self.castling.difference_update("kq")
        rights_by_square = {(7, 0): "Q", (7, 7): "K", (0, 0): "q", (0, 7): "k"}
        for square in (source, target):
            right = rights_by_square.get(square)
            if right:
                self.castling.discard(right)
        prior_ep = self.en_passant
        self._move_on(self.board, source, target, prior_ep)
        self.en_passant = ((sr + tr) // 2, sc) if piece.lower() == "p" and abs(tr - sr) == 2 else None
        self.halfmoves += 1
        self.turn = "black" if self.turn == "white" else "white"
        self.selected = None
        self.note = "CAPTURE" if captured != "." else ""
        if not self._all_legal(self.turn):
            self.over = True
            if self._in_check(self.turn):
                self.winner = "BLACK" if self.turn == "white" else "WHITE"
            else:
                self.winner = "DRAW"
        elif self._in_check(self.turn):
            self.note = "CHECK"

    def handle_key(self, key: str) -> bool:
        direction = self._DIRECTIONS.get(key)
        if direction:
            row, col = self.cursor
            self.cursor = ((row + direction[0]) % 8, (col + direction[1]) % 8)
            return True
        if key not in ("enter", "space") or self.over:
            return False
        if self.selected is None:
            if self._mine(self.board[self.cursor[0]][self.cursor[1]]):
                self.selected = self.cursor
                self.note = "SELECTED"
                return True
            self.note = "CHOOSE YOUR PIECE"
            return True
        if self.cursor == self.selected:
            self.selected = None
            self.note = ""
            return True
        legal = self.legal_moves(self.selected)
        if self.cursor in legal:
            self._move(self.selected, self.cursor)
            return True
        if self._mine(self.board[self.cursor[0]][self.cursor[1]]):
            self.selected = self.cursor
            self.note = "SELECTED"
        else:
            self.note = "ILLEGAL MOVE"
        return True

    def frame(self, width: int, height: int) -> GameFrame:
        footer = "ARROWS/WASD MOVE · ENTER/SPACE SELECT · R RESET · Q/ESC BACK"
        visible_rows = min(8, max(1, height))
        y0 = crop_origin(self.cursor[0], 8, visible_rows)
        targets = set(self.legal_moves(self.selected)) if self.selected and not self.over else set()
        rows = []
        for row in range(y0, y0 + visible_rows):
            cells = []
            for col in range(8):
                pos = (row, col)
                piece = self.board[row][col]
                glyph = self._GLYPHS.get(piece, "·")
                role = "chess-light" if (row + col) % 2 == 0 else "chess-dark"
                if pos in targets:
                    role = "chess-target"
                if pos == self.selected:
                    role = "chess-selected"
                if pos == self.cursor:
                    role = "board-cursor"
                cells.append((f" {glyph} ", role))
            rows.append(centered(cells, width))
        status = (f"CHECKMATE · {self.winner} WINS" if self.over and self.winner != "DRAW" else
                  "STALEMATE" if self.over else self.note)
        return GameFrame(self.title, f"{self.turn.upper()} TO MOVE · {self.halfmoves:03d}",
                         tuple(rows), footer, status=status)
