// Commits and issues as links in a chat (media/shared/inline.js draws them): what the host knows about a project's Git,
// the same for Work and for a Pip with a folder. The page never runs git and never names a folder: it sends the hashes
// it would like to link, and the host answers here, from the project's own folder.
//
// Everything git does here is read-only: `git cat-file -e <hash>^{commit}` says whether a hash is a commit, `git remote
// get-url origin` says where the project lives, `git show` is a commit's text. A hash is 7 to 40 hex digits and nothing
// else, git is run without a shell with its arguments as a list, in the project's folder, with a time limit, taking no
// lock and asking nothing. What it learns is kept for the session.
import { execFile } from "node:child_process";

export interface GitAnswer { remote: boolean; github: string; known: Record<string, boolean>; }

const HASH = /^[0-9a-f]{7,40}$/;
/** How many hashes one question may carry. */
export const HASH_PAGE = 64;
const SHOW_BYTES = 4 * 1024 * 1024;

/** `owner/repo` when an address is GitHub's own (https, ssh or git@), else "". Never the address itself: it may hold a token. */
export function githubOf(address: string): string {
  const text = String(address || "").trim();
  const m = /^(?:https?:\/\/(?:[^@\/\s]+@)?github\.com\/|ssh:\/\/git@github\.com(?::\d+)?\/|git@github\.com:)([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9_][\w.-]*?)(?:\.git)?\/?$/.exec(text);
  return m ? `${m[1]}/${m[2]}` : "";
}

interface Project { remote: boolean; github: string; known: Map<string, boolean>; full: Map<string, string>; }

export class GitRefs {
  /** How many times git was run (a test reads it). */
  ran = 0;
  private readonly projects = new Map<string, Promise<Project>>();

  private git(folder: string, args: string[], bytes = 64 * 1024): Promise<{ ok: boolean; out: string }> {
    this.ran += 1;
    return new Promise((resolve) => {
      try {
        execFile("git", ["--no-pager", "-c", "core.fsmonitor=false", ...args], {
          cwd: folder, timeout: 5000, maxBuffer: bytes, windowsHide: true, encoding: "utf8",
          env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", LC_ALL: "C" },
        }, (error, stdout) => resolve({ ok: !error, out: typeof stdout === "string" ? stdout : "" }));
      } catch { resolve({ ok: false, out: "" }); }
    });
  }

  private project(folder: string): Promise<Project> {
    let known = this.projects.get(folder);
    if (!known) {
      known = (async () => {
        const inside = await this.git(folder, ["rev-parse", "--is-inside-work-tree"]);
        if (!inside.ok || inside.out.trim() !== "true") { return { remote: false, github: "", known: new Map(), full: new Map() }; }
        const origin = await this.git(folder, ["remote", "get-url", "origin"]);
        let address = origin.ok ? origin.out.trim() : "";
        if (!address) {                                        // no origin: any remote makes it a project with a remote
          const names = await this.git(folder, ["remote"]);
          const first = names.ok ? names.out.split("\n").map((n) => n.trim()).find((n) => /^[\w.-]+$/.test(n)) : "";
          if (first) { const other = await this.git(folder, ["remote", "get-url", first]); address = other.ok ? other.out.trim() : ""; }
        }
        return { remote: !!address, github: githubOf(address), known: new Map(), full: new Map() };
      })();
      this.projects.set(folder, known);
    }
    return known;
  }

  /** Which of `hashes` are commits in the project at `folder`, and whether it has a remote (and GitHub's name for it).
   *  A project with no remote links nothing. Anything that is not a hash is left out of the answer. */
  async answer(folder: string, hashes: unknown): Promise<GitAnswer> {
    const none: GitAnswer = { remote: false, github: "", known: {} };
    if (typeof folder !== "string" || !folder) { return none; }
    const project = await this.project(folder);
    if (!project.remote) { return none; }
    const asked = [...new Set((Array.isArray(hashes) ? hashes : []).filter((h): h is string => typeof h === "string" && HASH.test(h)))].slice(0, HASH_PAGE);
    const known: Record<string, boolean> = {};
    for (const hash of asked) {
      if (!project.known.has(hash)) {
        const got = await this.git(folder, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${hash}^{commit}`]);
        const full = got.ok ? got.out.trim() : "";
        // (cat-file -e is the check; rev-parse above only names the whole hash, for the commit's GitHub address.)
        const there = /^[0-9a-f]{40,64}$/.test(full) && (await this.git(folder, ["cat-file", "-e", `${hash}^{commit}`])).ok;
        project.known.set(hash, there);
        if (there) { project.full.set(hash, full); }
      }
      known[hash] = project.known.get(hash) === true;
    }
    return { remote: true, github: project.github, known };
  }

  /** A commit's text (`git show`), its GitHub address first when the remote is GitHub. "" when it is not a commit there. */
  async show(folder: string, hash: unknown): Promise<string> {
    if (typeof hash !== "string" || !HASH.test(hash)) { return ""; }
    const said = await this.answer(folder, [hash]);
    if (said.known[hash] !== true) { return ""; }
    const project = await this.project(folder), full = project.full.get(hash) || hash;
    const got = await this.git(folder, ["show", "--no-color", "--no-ext-diff", "--no-textconv", "--stat", "--patch", "--end-of-options", full, "--"], SHOW_BYTES);
    if (!got.ok) { return ""; }
    return (said.github ? `View on GitHub: https://github.com/${said.github}/commit/${full}\n\n` : "") + got.out;
  }
}
