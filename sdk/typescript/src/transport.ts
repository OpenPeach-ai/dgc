import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export type Frame = Record<string, unknown>;

type Waiter = { resolve: (frame: Frame) => void; reject: (error: Error) => void };

export class Transport {
  private child: ChildProcessWithoutNullStreams;
  private buf = "";
  private queue: Frame[] = [];
  private waiters: Waiter[] = [];
  private dead: Error | null = null;

  constructor(argv: string[], cwd: string, env: NodeJS.ProcessEnv) {
    this.child = spawn(argv[0], argv.slice(1), { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      this.buf += chunk;
      let nl: number;
      while ((nl = this.buf.indexOf("\n")) !== -1) {
        const line = this.buf.slice(0, nl).trim();
        this.buf = this.buf.slice(nl + 1);
        if (!line) continue;
        try {
          const frame = JSON.parse(line) as Frame;
          const waiter = this.waiters.shift();
          if (waiter) waiter.resolve(frame);
          else this.queue.push(frame);
        } catch (err) {
          this.fail(err instanceof Error ? err : new Error(String(err)));
        }
      }
    });
    this.child.on("exit", () => this.fail(new Error("dgc serve exited")));
    this.child.stderr.setEncoding("utf8");
  }

  send(command: Frame): void {
    if (this.dead) throw this.dead;
    this.child.stdin.write(JSON.stringify(command) + "\n");
  }

  unread(frame: Frame): void {
    this.queue.unshift(frame);
  }

  next(timeoutMs: number): Promise<Frame> {
    if (this.dead) return Promise.reject(this.dead);
    if (this.queue.length) return Promise.resolve(this.queue.shift() as Frame);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex((item) => item.reject === reject || item.resolve === resolve);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error("timed out waiting for DGC event"));
      }, timeoutMs);
      this.waiters.push({
        resolve: (frame) => { clearTimeout(timer); resolve(frame); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
    });
  }

  async request(command: Frame, responseType: string, timeoutMs = 15_000): Promise<Frame> {
    this.send(command);
    const deadline = Date.now() + timeoutMs;
    const held: Frame[] = [];
    const requestId = typeof command.request_id === "string" ? command.request_id : undefined;
    while (Date.now() < deadline) {
      const frame = await this.next(Math.max(50, deadline - Date.now()));
      if (frame.type === responseType && (!requestId || frame.request_id === requestId)) {
        for (let i = held.length - 1; i >= 0; i--) this.unread(held[i]);
        return frame;
      }
      held.push(frame);
    }
    for (let i = held.length - 1; i >= 0; i--) this.unread(held[i]);
    throw new Error(`timed out waiting for ${responseType}`);
  }

  close(): void {
    try { this.send({ type: "shutdown" }); } catch { /* already dead */ }
    this.child.kill("SIGTERM");
    this.fail(new Error("dgc serve closed"));
  }

  private fail(error: Error): void {
    if (this.dead) return;
    this.dead = error;
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) waiter.reject(error);
  }
}
