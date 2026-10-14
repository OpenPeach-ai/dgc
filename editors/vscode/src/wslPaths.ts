// Windows paths <-> the paths DGC sees inside its WSL distro (hidden WSL, src/wslHost.ts).
//
// The extension runs on Windows and names files C:\Users\me\proj; `dgc serve` runs in a Linux distro
// and names the same file /mnt/c/Users/me/proj. A file only Linux has (~/.dgc/...) is
// \\wsl.localhost\<distro>\home\dgc\.dgc\... to Windows. Pure functions: no fs, no vscode.

export type PathMap = { toLinux(path: string): string; toWindows(path: string): string };

const DRIVE = /^([A-Za-z]):(?:[\\/](.*))?$/su;
const LONG = /^\\\\\?\\(?=[A-Za-z]:)/u;           // \\?\C:\... (a long-path prefix)

/** The map for one distro whose Windows drives are mounted under `driveRoot` (wsl.conf automount.root). */
export function pathMap(distro: string, driveRoot = "/mnt/"): PathMap {
  const root = driveRoot.endsWith("/") ? driveRoot : driveRoot + "/";
  const unc = new RegExp(`^\\\\\\\\(?:wsl\\.localhost|wsl\\$)\\\\${escape(distro)}(?=\\\\|$)(.*)$`, "isu");
  const mounted = new RegExp(`^${escape(root)}([a-z])(?:/(.*))?$`, "su");
  return {
    toLinux(path: string): string {
      if (typeof path !== "string" || !path) { return path; }
      const plain = path.replace(LONG, "");
      const drive = DRIVE.exec(plain);
      if (drive) {
        const rest = (drive[2] ?? "").replace(/\\/g, "/").replace(/\/+$/u, "");
        return `${root}${drive[1].toLowerCase()}${rest ? "/" + rest : ""}`;
      }
      const inside = unc.exec(plain);
      if (inside) {
        const rest = inside[1].replace(/\\/g, "/").replace(/\/+$/u, "");
        return rest || "/";
      }
      return path;                                   // relative, another machine's share, or already Linux
    },
    toWindows(path: string): string {
      if (typeof path !== "string" || !path.startsWith("/")) { return path; }
      const drive = mounted.exec(path);
      if (drive) {
        const rest = (drive[2] ?? "").replace(/\/+$/u, "").replace(/\//g, "\\");
        return `${drive[1].toUpperCase()}:\\${rest}`;
      }
      return `\\\\wsl.localhost\\${distro}${path === "/" ? "\\" : path.replace(/\/+$/u, "").replace(/\//g, "\\")}`;
    },
  };
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}
