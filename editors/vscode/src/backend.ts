import * as vscode from "vscode";
import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import { EventEmitter } from "events";

/** Any protocol event from `dgc serve` (see dgc/headless.py). */
export interface DgcEvent {
  type: string;
  [k: string]: any;
}

/**
 * Owns the `dgc serve` child process: writes JSON commands to its stdin, parses
 * newline-delimited JSON from its stdout, and re-emits each event by `type`.
 * Also emits "event" for every event and "exit" when the child dies.
 */
export class DgcBackend extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | undefined;
  private buf = "";
  ready = false;

  constructor(private readonly cwd: string, private readonly command: string) {
    super();
  }

  start(): void {
    if (this.proc) {
      return;
    }
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.command, ["serve"], {
        cwd: this.cwd,
        env: { ...process.env },
      });
    } catch (err: any) {
      this.emit("event", { type: "error", message: `could not launch '${this.command} serve': ${err?.message ?? err}`, fatal: true, notInstalled: err?.code === "ENOENT" });
      return;
    }
    this.proc = child;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      // dgc serve sends only diagnostics to stderr — surface them but don't treat as protocol
      const text = String(chunk).trim();
      if (text) {
        this.emit("stderr", text);
      }
    });
    child.on("error", (err: any) => {
      const missing = err?.code === "ENOENT";
      this.emit("event", {
        type: "error",
        message: missing
          ? `The DGC CLI ('${this.command}') isn't installed or isn't on PATH.`
          : `dgc backend failed to start: ${err?.message ?? err}. Set "dgc.command" to your dgc path (needs v0.4.0+).`,
        fatal: true,
        notInstalled: missing,
      });
    });
    child.on("exit", (code) => {
      this.proc = undefined;
      this.ready = false;
      this.emit("exit", code);
    });
  }

  private onStdout(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) !== -1) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) {
        continue;
      }
      let ev: DgcEvent;
      try {
        ev = JSON.parse(line);
      } catch {
        continue; // ignore any non-JSON noise
      }
      if (ev.type === "ready") {
        this.ready = true;
      }
      this.emit("event", ev);
      this.emit(ev.type, ev);
    }
  }

  /** Send one command object to the backend. */
  send(cmd: Record<string, any>): void {
    if (!this.proc || !this.proc.stdin.writable) {
      return;
    }
    try {
      this.proc.stdin.write(JSON.stringify(cmd) + "\n");
    } catch {
      /* pipe closed — the exit handler will fire */
    }
  }

  dispose(): void {
    if (this.proc) {
      try {
        this.send({ type: "shutdown" });
      } catch {
        /* ignore */
      }
      const p = this.proc;
      this.proc = undefined;
      setTimeout(() => {
        try {
          p.kill();
        } catch {
          /* ignore */
        }
      }, 300);
    }
  }
}
