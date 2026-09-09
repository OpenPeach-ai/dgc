"""Turn ETA: a calibrated, blended estimate of how long the running turn still needs.

Three sources feed one range:

* a **prior** — this project's own history of turn durations, bucketed by what the prompt asks
  for (explain / test / fix / add / refactor / other) and how long it is;
* the turn's **structure** — the todo list the model keeps, so remaining tasks × the pace of the
  tasks already finished;
* **elapsed time** itself, which shifts a heavy-tailed prior toward "still going".

The result is shown as a range (``~2–4 min left · 3/5 tasks``) and never as a promise. Every
turn records predicted-vs-actual so ``/eta stats`` can report how often the range held.
"""
from __future__ import annotations

import json
import math
import os
import re
import statistics
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

from .config import USER_HOME

STATS_FILE = USER_HOME / "eta-stats.json"
FORMAT_VERSION = 1
MAX_SAMPLES = 60            # durations kept per bucket
MAX_RECORDS = 240           # predicted-vs-actual rows kept
MAX_FILE_BYTES = 256 * 1024
SHOW_AFTER_S = 20.0         # surfaces hide the estimate before this much elapsed time
CHECKPOINT_S = 20.0         # the estimate scored for calibration is the one shown at this moment
MIN_TASK_S = 6.0

_VERB_RULES = (
    ("explain", re.compile(r"\b(explain|what|why|how does|describe|summari[sz]e|list|show|read|walk me|tell me|which|where)\b", re.I)),
    ("test", re.compile(r"\b(tests?|spec|coverage|unit test|pytest|jest)\b", re.I)),
    ("fix", re.compile(r"\b(fix|bug|error|fails?|failing|broken|crash|regression|debug|issue)\b", re.I)),
    ("refactor", re.compile(r"\b(refactor|rename|move|clean ?up|extract|split|reorgani[sz]e|simplify|restructure)\b", re.I)),
    ("add", re.compile(r"\b(add|create|implement|build|write|new|introduce|support|generate|make)\b", re.I)),
)

# Cold-start priors in seconds (p50, p80) per verb class. The coding values sit around the
# 121.7 s mean round measured on the polyglot slice; explanations are answered in one request.
_DEFAULT_PRIORS = {
    "explain": (15.0, 45.0),
    "test": (90.0, 300.0),
    "fix": (120.0, 420.0),
    "add": (150.0, 480.0),
    "refactor": (180.0, 600.0),
    "other": (60.0, 240.0),
}
_DEFAULT_TASK_S = 45.0


@dataclass(frozen=True)
class PromptFeatures:
    verb: str
    length: str          # short | medium | long
    mode: str
    goal: bool
    model: str = ""

    @property
    def bucket(self) -> str:
        return f"{self.verb}/{self.length}"

    @property
    def coarse(self) -> str:
        return self.verb


def classify_prompt(text: str, *, mode: str = "default", goal: bool = False, model: str = "") -> PromptFeatures:
    body = str(text or "")
    words = len(body.split())
    length = "short" if words < 12 else ("medium" if words < 60 else "long")
    verb = "other"
    # Precedence: explicit test/fix/refactor/add verbs beat the loose "explain" words, which also
    # appear in coding requests ("show a diff", "what is broken"), so check them first.
    for name in ("test", "fix", "refactor", "add"):
        rule = dict(_VERB_RULES)[name]
        if rule.search(body):
            verb = name
            break
    else:
        if dict(_VERB_RULES)["explain"].search(body) or body.rstrip().endswith("?"):
            verb = "explain"
    return PromptFeatures(verb, length, str(mode or "default"), bool(goal), str(model or "")[:64])


@dataclass
class Eta:
    elapsed: float
    low: float                 # remaining seconds (low edge)
    high: float                # remaining seconds (high edge)
    confidence: float          # 0..1
    basis: str                 # prior | structure | blend
    tasks_done: int = 0
    tasks_total: int = 0
    progress: float | None = None

    @property
    def visible(self) -> bool:
        return self.elapsed >= SHOW_AFTER_S

    @property
    def label(self) -> str:
        """Compact human text: ``~2–4 min left · 3/5 tasks`` or a hedge when confidence is low."""
        tasks = f" · {self.tasks_done}/{self.tasks_total} tasks" if self.tasks_total else ""
        if self.confidence < 0.25:
            return "~a few min left" + tasks if self.high >= 90 else "~under a minute left" + tasks
        return f"~{_span(self.low, self.high)} left{tasks}"


def _span(low: float, high: float) -> str:
    low, high = max(0.0, low), max(low, high)
    if high < 60:
        lo, hi = int(round(low / 5.0)) * 5, int(math.ceil(high / 5.0)) * 5
        return f"{hi}s" if hi - lo < 10 else f"{lo}–{hi} s"
    lo_m, hi_m = max(1, int(round(low / 60.0))), max(1, int(math.ceil(high / 60.0)))
    if hi_m >= 60:
        return f"{lo_m // 60}h+" if lo_m >= 60 else f"{lo_m}–{hi_m} min"
    return f"{hi_m} min" if hi_m == lo_m else f"{lo_m}–{hi_m} min"


def _quantiles(samples: list[float]) -> tuple[float, float]:
    ordered = sorted(float(s) for s in samples if math.isfinite(s) and s >= 0)
    if not ordered:
        return 0.0, 0.0
    if len(ordered) == 1:
        return ordered[0], ordered[0] * 1.6
    def pick(q: float) -> float:
        position = q * (len(ordered) - 1)
        base = int(position)
        frac = position - base
        upper = ordered[min(base + 1, len(ordered) - 1)]
        return ordered[base] + (upper - ordered[base]) * frac
    return pick(0.5), pick(0.8)


class EtaStats:
    """Bounded, owner-private per-project history of turn durations and prediction outcomes."""

    def __init__(self, path: Path | None = None, *, project: str = ""):
        self.path = Path(path) if path is not None else STATS_FILE
        self.project = str(project or "")
        self._lock = threading.RLock()
        self.data = {"version": FORMAT_VERSION, "projects": {}}
        self._load()

    # ---- persistence -------------------------------------------------------------------------
    def _load(self) -> None:
        try:
            if self.path.exists() and self.path.stat().st_size <= MAX_FILE_BYTES:
                loaded = json.loads(self.path.read_text(encoding="utf-8"))
                if isinstance(loaded, dict) and isinstance(loaded.get("projects"), dict):
                    self.data = {"version": FORMAT_VERSION, "projects": loaded["projects"]}
        except (OSError, ValueError, TypeError):
            self.data = {"version": FORMAT_VERSION, "projects": {}}

    def save(self) -> bool:
        with self._lock:
            payload = json.dumps(self.data, separators=(",", ":"), sort_keys=True)
            if len(payload) > MAX_FILE_BYTES:
                self._trim()
                payload = json.dumps(self.data, separators=(",", ":"), sort_keys=True)
            try:
                self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                tmp = self.path.with_name(self.path.name + f".{os.getpid()}.tmp")
                tmp.write_text(payload, encoding="utf-8")
                os.chmod(tmp, 0o600)
                os.replace(tmp, self.path)
                return True
            except OSError:
                return False

    def _trim(self) -> None:
        for project in self.data["projects"].values():
            for bucket in project.get("buckets", {}).values():
                del bucket[:-MAX_SAMPLES // 2]
            project["records"] = project.get("records", [])[-MAX_RECORDS // 2:]

    def _project(self) -> dict:
        projects = self.data["projects"]
        entry = projects.get(self.project)
        if not isinstance(entry, dict):
            entry = projects[self.project] = {"buckets": {}, "records": [], "tasks": []}
        entry.setdefault("buckets", {})
        entry.setdefault("records", [])
        entry.setdefault("tasks", [])
        return entry

    # ---- reads -------------------------------------------------------------------------------
    def prior(self, features: PromptFeatures) -> tuple[float, float, int]:
        """(p50, p80, samples) for the finest bucket with enough history, else the defaults."""
        with self._lock:
            buckets = self._project()["buckets"]
            for key in (features.bucket, features.coarse):
                samples = [s for s in buckets.get(key, []) if isinstance(s, (int, float))]
                if len(samples) >= 3:
                    p50, p80 = _quantiles(samples)
                    return max(5.0, p50), max(10.0, p80), len(samples)
            merged = [s for key in buckets if key.startswith(features.verb)
                      for s in buckets[key] if isinstance(s, (int, float))]
            if len(merged) >= 3:
                p50, p80 = _quantiles(merged)
                return max(5.0, p50), max(10.0, p80), len(merged)
        p50, p80 = _DEFAULT_PRIORS.get(features.verb, _DEFAULT_PRIORS["other"])
        return p50, p80, 0

    def task_seconds(self) -> float:
        with self._lock:
            samples = [s for s in self._project()["tasks"] if isinstance(s, (int, float))]
        if len(samples) < 3:
            return _DEFAULT_TASK_S
        return max(MIN_TASK_S, statistics.median(samples))

    # ---- writes ------------------------------------------------------------------------------
    def record_turn(self, features: PromptFeatures, actual: float, *,
                    checkpoint: tuple[float, float] | None) -> None:
        with self._lock:
            project = self._project()
            for key in (features.bucket,):
                bucket = project["buckets"].setdefault(key, [])
                bucket.append(round(float(actual), 1))
                del bucket[:-MAX_SAMPLES]
            if checkpoint is not None:
                project["records"].append({
                    "bucket": features.bucket, "actual": round(float(actual), 1),
                    "low": round(float(checkpoint[0]), 1), "high": round(float(checkpoint[1]), 1),
                    "ts": int(time.time())})
                del project["records"][:-MAX_RECORDS]

    def record_task(self, seconds: float) -> None:
        with self._lock:
            tasks = self._project()["tasks"]
            tasks.append(round(float(seconds), 1))
            del tasks[:-MAX_SAMPLES]

    def summary(self) -> dict:
        """Calibration for `/eta stats`: how often the shown range contained the real duration."""
        with self._lock:
            project = self._project()
            records = [r for r in project["records"] if isinstance(r, dict)]
            buckets = {k: len(v) for k, v in project["buckets"].items()}
        scored = [r for r in records if all(isinstance(r.get(k), (int, float)) for k in ("actual", "low", "high"))]
        inside = sum(1 for r in scored if r["low"] <= r["actual"] <= r["high"])
        under = sum(1 for r in scored if r["actual"] > r["high"])
        errors = [abs((r["low"] + r["high"]) / 2 - r["actual"]) / max(1.0, r["actual"]) for r in scored]
        return {
            "turns": sum(buckets.values()), "scored": len(scored),
            "coverage": (inside / len(scored)) if scored else None,
            "ran_over": (under / len(scored)) if scored else None,
            "median_error": (statistics.median(errors) if errors else None),
            "buckets": buckets,
        }


class TurnEstimator:
    """One running turn's estimate, updated by the agent's own events."""

    def __init__(self, stats: EtaStats | None, features: PromptFeatures, *, now: float | None = None):
        self.stats = stats
        self.features = features
        self.started = time.monotonic() if now is None else float(now)
        self.p50, self.p80, self.samples = (stats.prior(features) if stats else
                                            (*_DEFAULT_PRIORS.get(features.verb, _DEFAULT_PRIORS["other"]), 0))
        self.task_pace = stats.task_seconds() if stats else _DEFAULT_TASK_S
        self.tasks_done = 0
        self.tasks_total = 0
        self._task_marks: list[float] = []      # completion moments, for pace
        self._done_seen = 0
        self.requests = 0
        self.output_tokens = 0
        self.tool_seconds = 0.0
        self.retries = 0
        self._last: Eta | None = None
        self._checkpoint: tuple[float, float] | None = None
        self.finished = False
        self._lock = threading.Lock()

    # ---- events ------------------------------------------------------------------------------
    def on_request(self, output_tokens: int = 0) -> None:
        with self._lock:
            self.requests += 1
            self.output_tokens += max(0, int(output_tokens or 0))

    def on_tool(self, name: str, seconds: float) -> None:
        with self._lock:
            self.tool_seconds += max(0.0, float(seconds or 0.0))

    def on_todos(self, todos, *, now: float | None = None) -> None:
        moment = time.monotonic() if now is None else float(now)
        total = done = 0
        for item in todos or []:
            if not isinstance(item, dict):
                continue
            status = str(item.get("status", "pending"))
            if status == "cancelled":
                continue
            total += 1
            if status == "done":
                done += 1
        with self._lock:
            if done > self._done_seen:
                previous = self._task_marks[-1] if self._task_marks else self.started
                for _ in range(done - self._done_seen):
                    self._task_marks.append(moment)
                    if self.stats is not None and moment - previous >= MIN_TASK_S:
                        self.stats.record_task((moment - previous) / max(1, done - self._done_seen))
                self._done_seen = done
            self.tasks_done, self.tasks_total = done, total

    def on_retry(self, reason: str = "") -> None:
        """A failed verification widens the range instead of letting it silently overshoot."""
        with self._lock:
            self.retries += 1

    # ---- estimate ----------------------------------------------------------------------------
    def estimate(self, *, now: float | None = None) -> Eta:
        moment = time.monotonic() if now is None else float(now)
        with self._lock:
            elapsed = max(0.0, moment - self.started)
            # Prior: a heavy-tailed turn that has already run past p50 is likelier to run on.
            prior_low = max(self.p50 - elapsed, 0.15 * elapsed, 5.0)
            prior_high = max(self.p80 - elapsed, 0.6 * elapsed, prior_low + 10.0)
            basis, low, high = "prior", prior_low, prior_high
            structural = None
            remaining_tasks = max(0, self.tasks_total - self.tasks_done)
            if self.tasks_total:
                if self.tasks_done >= 1:
                    pace = (self._task_marks[-1] - self.started) / self.tasks_done
                    pace = max(MIN_TASK_S, pace)
                else:
                    pace = self.task_pace
                # the current task is partly done: credit elapsed time since the last completion
                since_last = elapsed - ((self._task_marks[-1] - self.started) if self._task_marks else 0.0)
                current_left = max(0.0, pace - since_last) if remaining_tasks else 0.0
                total_left = current_left + max(0, remaining_tasks - 1) * pace
                structural = (max(5.0, 0.7 * total_left), max(15.0, 1.5 * total_left + 10.0))
            if structural is not None:
                weight = 0.75 if self.tasks_done >= 1 else 0.45
                low = weight * structural[0] + (1 - weight) * prior_low
                high = weight * structural[1] + (1 - weight) * prior_high
                basis = "structure" if weight >= 0.75 else "blend"
            if self.retries:
                widen = 1.0 + 0.35 * min(3, self.retries)
                high *= widen
                low *= 1.0 + 0.1 * min(3, self.retries)
            # Monotone smoothing: the range may shrink freely but only grow when evidence says so.
            previous = self._last
            if previous is not None and previous.high > 0 and not self.retries:
                prev_high_now = max(0.0, previous.high - (elapsed - previous.elapsed))
                if high > prev_high_now * 1.25 and basis == previous.basis:
                    high = max(low + 5.0, prev_high_now * 1.25)
            if high < low:
                high = low + 5.0
            confidence = min(1.0, 0.25 + 0.05 * self.samples)
            if structural is not None and self.tasks_done >= 1:
                confidence = min(1.0, confidence + 0.35)
            elif structural is not None:
                confidence = min(1.0, confidence + 0.1)
            if self.retries:
                confidence *= 0.6
            progress = None
            if self.tasks_total:
                progress = min(0.99, self.tasks_done / self.tasks_total)
            eta = Eta(elapsed=elapsed, low=low, high=high, confidence=confidence, basis=basis,
                      tasks_done=self.tasks_done, tasks_total=self.tasks_total, progress=progress)
            self._last = eta
            if self._checkpoint is None and elapsed >= CHECKPOINT_S:
                self._checkpoint = (elapsed + low, elapsed + high)      # predicted total duration
            return eta

    def finish(self, *, now: float | None = None, completed: bool = True) -> float:
        moment = time.monotonic() if now is None else float(now)
        with self._lock:
            if self.finished:
                return max(0.0, moment - self.started)
            self.finished = True
            actual = max(0.0, moment - self.started)
            checkpoint = self._checkpoint
        if self.stats is not None and completed and actual >= 3.0:
            try:
                self.stats.record_turn(self.features, actual, checkpoint=checkpoint)
                self.stats.save()
            except Exception:
                pass    # calibration is subordinate to the turn itself
        return actual


def format_stats(summary: dict) -> str:
    coverage = summary.get("coverage")
    lines = ["# Turn ETA", ""]
    if not summary.get("turns"):
        lines.append("No finished turns recorded for this project yet. The estimate starts from "
                     "DGC's built-in priors and calibrates as turns complete.")
        return "\n".join(lines)
    lines.append(f"**Turns recorded:** {summary['turns']} · **scored:** {summary['scored']}")
    if coverage is not None:
        lines.append(f"**Range held:** {coverage:.0%} of scored turns finished inside the range shown at "
                     f"{int(CHECKPOINT_S)} s · **ran over:** {summary['ran_over']:.0%}")
    if summary.get("median_error") is not None:
        lines.append(f"**Median error of the midpoint:** {summary['median_error']:.0%}")
    lines.append("")
    lines.append("## Buckets")
    for key, count in sorted(summary.get("buckets", {}).items()):
        lines.append(f"- `{key}` — {count} turn{'s' if count != 1 else ''}")
    return "\n".join(lines)
