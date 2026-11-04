"""`dgc node`: DGC Router's tiny read-only stats service for another computer.

GET /v1/stats behind a pairing token (only its digest kept), nothing else: no shell, no file access, no model. It
reads nvidia-smi, amd-smi / rocm-smi (looked for in /opt/rocm*/bin too), rocminfo, amdgpu's sysfs counters and /proc
on Linux, and sysctl, vm_stat and ioreg on macOS. install-service writes a systemd user unit, a LaunchAgent or (macOS
--system) a LaunchDaemon with UserName.
"""
from __future__ import annotations

import io
import json
import os
import plistlib
import stat
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import router_hw_fixtures as F  # noqa: E402

from dgc import node  # noqa: E402

GIB = 1024 ** 3


class Home(unittest.TestCase):
    def setUp(self):
        self.home = Path(tempfile.mkdtemp(prefix="dgc-node-"))
        env = patch.dict(os.environ, {"DGC_HOME": str(self.home)})
        env.start()
        self.addCleanup(env.stop)


class Parsers(unittest.TestCase):
    def test_nvidia_smi_a_card_and_a_gb10(self):
        cards = node.parse_nvidia_smi(F.NVIDIA_SMI_CARDS)
        self.assertEqual(cards[0], {"name": "NVIDIA GeForce RTX 4090", "vendor": "nvidia", "util_pct": 34.0,
                                    "temp_c": 61.0, "power_w": 287.5, "source": "nvidia-smi",
                                    "memory_total_bytes": 24564 * 1048576, "memory_used_bytes": 18000 * 1048576})
        self.assertNotIn("power_w", cards[1], "[N/A] is simply absent")
        gb10 = node.parse_nvidia_smi(F.NVIDIA_SMI_GB10)[0]
        self.assertTrue(gb10["unified"], "no memory of its own: it shares the computer's")
        self.assertNotIn("memory_total_bytes", gb10)

    def test_proc_files(self):
        self.assertEqual(node.parse_meminfo(F.MEMINFO), {"total_bytes": 129466208 * 1024,
                                                         "available_bytes": 92738648 * 1024})
        self.assertEqual(node.parse_loadavg(F.LOADAVG), 0.77)
        busy, total = node.parse_proc_stat(F.PROC_STAT)
        later = node.parse_proc_stat(F.PROC_STAT_LATER)
        self.assertEqual((later[0] - busy, later[1] - total), (2000, 11000))

    def test_amd_tools(self):
        self.assertEqual(node._amd_name_from_rocminfo(F.ROCMINFO), ["Radeon 8060S Graphics"], "the GPU agent only")
        metric = node.parse_amd_smi_metric(F.AMD_SMI_METRIC)[0]
        self.assertEqual((metric["util_pct"], metric["temp_c"], metric["power_w"], metric["memory_total_bytes"]),
                         (21.0, 52.0, 305.0, 196592 * 1048576))
        self.assertEqual(node._amd_names_from_smi(F.AMD_SMI_STATIC, ""), ["AMD Instinct MI300X"])
        rocm = node.parse_rocm_smi(F.ROCM_SMI)[0]
        self.assertEqual((rocm["util_pct"], rocm["temp_c"], rocm["power_w"], rocm["memory_used_bytes"]),
                         (7.0, 44.0, 35.0, 1073741824))
        self.assertEqual(node._amd_names_from_smi("", F.ROCM_SMI_NAMES), ["Radeon RX 7800 XT"])

    def test_macos_tools(self):
        self.assertEqual(node.parse_vm_stat(F.VM_STAT), {"available_bytes": (50000 + 600000 + 10000 + 40000) * 16384})
        self.assertEqual(node.parse_ioreg_accelerator(F.IOREG_ACCELERATOR),
                         {"name": "Apple M2 Ultra", "util_pct": 12.0, "in_use_bytes": 38654705664, "cores": 76})


def drm_tree(root: Path, *, apu: bool) -> Path:
    """A /sys/class/drm with one amdgpu card (and a connector that isn't one)."""
    device = root / "card0" / "device"
    (device / "hwmon" / "hwmon3").mkdir(parents=True)
    (root / "card0-DP-1").mkdir()
    files = {"vendor": "0x1002\n", "gpu_busy_percent": "12\n", "mem_info_vram_total": f"{2 * GIB}\n",
             "mem_info_vram_used": "171425792\n", "mem_info_gtt_total": "112742891520\n",
             "mem_info_gtt_used": "7129608192\n", "uevent": "DRIVER=amdgpu\nPCI_SLOT_NAME=0000:f4:00.0\n"}
    if not apu:
        files.update(mem_info_vram_total=f"{16 * GIB}\n", mem_info_vram_used=f"{4 * GIB}\n")
    for name, text in files.items():
        (device / name).write_text(text)
    (device / "gpu_metrics").write_bytes(bytes([8, 1, 3 if apu else 1, 0]) + b"\0" * 60)
    (device / "hwmon" / "hwmon3" / "temp1_input").write_text("30000\n")
    (device / "hwmon" / "hwmon3" / "power1_average").write_text("16036000\n")
    return root


class AmdSysfs(unittest.TestCase):
    def test_an_apu_holds_vram_and_gtt_together(self):
        root = drm_tree(Path(tempfile.mkdtemp(prefix="dgc-drm-")), apu=True)
        gpus = node.amd_sysfs(str(root))
        self.assertEqual(len(gpus), 1, "card0-DP-1 is a connector, not a GPU")
        gpu = gpus[0]
        self.assertTrue(gpu["unified"])
        self.assertEqual(gpu["memory_total_bytes"], 2 * GIB + 112742891520)
        self.assertEqual(gpu["memory_used_bytes"], 171425792 + 7129608192)
        self.assertEqual((gpu["util_pct"], gpu["temp_c"], gpu["power_w"]), (12.0, 30.0, 16.0))

    def test_a_card_counts_its_vram_only(self):
        gpu = node.amd_sysfs(str(drm_tree(Path(tempfile.mkdtemp(prefix="dgc-drm-")), apu=False)))[0]
        self.assertNotIn("unified", gpu)
        self.assertEqual((gpu["memory_total_bytes"], gpu["memory_used_bytes"]), (16 * GIB, 4 * GIB))

    def test_rocm_tools_are_found_in_opt_rocm_when_not_on_path(self):
        folder = Path(tempfile.mkdtemp(prefix="dgc-rocm-")) / "bin"
        folder.mkdir()
        tool = folder / "rocminfo"
        tool.write_text("#!/bin/sh\n")
        tool.chmod(tool.stat().st_mode | stat.S_IXUSR)
        with patch.object(node.shutil, "which", return_value=None):
            self.assertEqual(node._which("rocminfo", [str(folder)]), str(tool))
            self.assertEqual(node._which("amd-smi", [str(folder)]), "")
        self.assertIn("/opt", node._which.__code__.co_consts, "ROCm's own folders are always looked in")


class Collecting(unittest.TestCase):
    def collector(self, system, outputs, files, drm=None):
        def run(argv, timeout=node.TOOL_TIMEOUT):
            return outputs.get(Path(argv[0]).name + " " + " ".join(argv[1:3]), outputs.get(Path(argv[0]).name, ""))
        return node.Collector(runner=run, reader=lambda path, limit=0: files.get(path, ""), system=system,
                              drm_root=drm or "/nonexistent")

    def test_linux_nvidia_gb10_shares_the_computers_memory(self):
        files = {"/proc/meminfo": F.MEMINFO, "/proc/loadavg": F.LOADAVG, "/proc/stat": F.PROC_STAT}
        with patch.object(node, "_which", lambda name, extra=(): f"/usr/bin/{name}" if name == "nvidia-smi" else ""):
            stats = self.collector("Linux", {"nvidia-smi": F.NVIDIA_SMI_GB10}, files).stats()
        gpu = stats["gpus"][0]
        self.assertEqual(gpu["memory_total_bytes"], 129466208 * 1024)
        self.assertEqual(gpu["memory_used_bytes"], (129466208 - 92738648) * 1024)
        self.assertTrue(stats["unified_memory"])
        self.assertEqual(stats["cpu"]["load1"], 0.77)
        self.assertEqual(stats["sources"], ["/proc/meminfo", "nvidia-smi"])

    def test_linux_amd_apu_without_rocm_smi_uses_sysfs_and_rocminfo(self):
        root = drm_tree(Path(tempfile.mkdtemp(prefix="dgc-drm-")), apu=True)
        files = {"/proc/meminfo": F.MEMINFO, "/proc/loadavg": F.LOADAVG, "/proc/stat": F.PROC_STAT}
        with patch.object(node, "_which", lambda name, extra=(): "/opt/rocm/bin/rocminfo" if name == "rocminfo" else ""):
            stats = self.collector("Linux", {"rocminfo": F.ROCMINFO}, files, drm=str(root)).stats()
        self.assertEqual(stats["gpus"][0]["name"], "Radeon 8060S Graphics")
        self.assertEqual(stats["sources"], ["/proc/meminfo", "rocminfo", "amdgpu sysfs"])
        self.assertTrue(stats["unified_memory"])

    def test_linux_amd_card_with_rocm_smi(self):
        root = drm_tree(Path(tempfile.mkdtemp(prefix="dgc-drm-")), apu=False)
        outputs = {"rocm-smi --showuse --showtemp": F.ROCM_SMI, "rocm-smi --showproductname --json": F.ROCM_SMI_NAMES}
        with patch.object(node, "_which", lambda name, extra=(): "/opt/rocm/bin/rocm-smi" if name == "rocm-smi" else ""):
            stats = self.collector("Linux", outputs, {"/proc/meminfo": F.MEMINFO}, drm=str(root)).stats()
        gpu = stats["gpus"][0]
        self.assertEqual(gpu["name"], "Radeon RX 7800 XT")
        self.assertEqual(gpu["memory_total_bytes"], 16 * GIB, "sysfs first")
        self.assertIn("rocm-smi", stats["sources"])

    def test_macos_unified_memory_is_the_gpus(self):
        outputs = {"sysctl -n hw.memsize": str(192 * GIB), "vm_stat": F.VM_STAT, "sysctl -n vm.loadavg": "{ 1.50 1.2 1.1 }",
                   "sysctl -n hw.ncpu": "24", "sysctl -n machdep.cpu.brand_string": "Apple M2 Ultra",
                   "ioreg -r -d": F.IOREG_ACCELERATOR, "sysctl -n iogpu.wired_limit_mb": "0"}
        stats = self.collector("Darwin", outputs, {}).stats()
        gpu = stats["gpus"][0]
        self.assertEqual((gpu["name"], gpu["util_pct"], gpu["memory_total_bytes"]), ("Apple M2 Ultra", 12.0, 192 * GIB))
        self.assertNotIn("temp_c", gpu, "temperature needs powermetrics (root): left out")
        self.assertEqual(stats["cpu"], {"cores": 24, "load1": 1.5})
        self.assertTrue(stats["unified_memory"])

    def test_a_burst_reads_once(self):
        calls = []
        collector = node.Collector(runner=lambda argv, timeout=0: calls.append(argv) or "", reader=lambda p, limit=0: "",
                                   system="Linux", drm_root="/nonexistent")
        with patch.object(node, "_which", lambda name, extra=(): "/usr/bin/nvidia-smi" if name == "nvidia-smi" else ""):
            collector.stats()
            collector.stats()
        self.assertEqual(len(calls), 1)


class Service(Home):
    def serve(self):
        server = node.make_server(0, "127.0.0.1", node.Collector(runner=lambda *a, **k: "", reader=lambda p, limit=0:
                                                                 F.MEMINFO if p == "/proc/meminfo" else "",
                                                                 system="Linux", drm_root="/nonexistent"))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return f"http://127.0.0.1:{server.server_address[1]}"

    def get(self, url, token=None, method="GET"):
        request = urllib.request.Request(url, method=method, headers={"Authorization": f"Bearer {token}"} if token else {})
        try:
            with urllib.request.urlopen(request, timeout=5) as response:
                return response.status, dict(response.headers), json.loads(response.read() or b"{}")
        except urllib.error.HTTPError as exc:
            return exc.code, dict(exc.headers), json.loads(exc.read() or b"{}")

    def test_stats_behind_the_token_and_nothing_else(self):
        token = node.new_token()
        url = self.serve()
        status, headers, body = self.get(url + "/v1/stats")
        self.assertEqual((status, body.get("dgc_node")), (401, 1), "it says what it is, and nothing more")
        self.assertNotIn("memory", body)
        self.assertEqual(self.get(url + "/v1/stats", "dgcn_wrong")[0], 401)
        status, headers, body = self.get(url + "/v1/stats", token)
        self.assertEqual(status, 200)
        self.assertEqual(body["memory"]["total_bytes"], 129466208 * 1024)
        self.assertEqual(headers.get("Server"), "dgc-node", "no Python version")
        for path in ("/", "/v1/stats/../../etc/passwd", "/v1/exec", "/metrics"):
            self.assertEqual(self.get(url + path, token)[0], 404, path)
        self.assertEqual(self.get(url + "/v1/stats", token, method="POST")[0], 405)

    def test_only_the_digest_is_kept_and_a_new_token_works_without_a_restart(self):
        first = node.new_token()
        url = self.serve()
        kept = (self.home / ".dgc" / "node" / "node.json").read_text()
        self.assertNotIn(first, kept)
        self.assertEqual(stat.S_IMODE((self.home / ".dgc" / "node" / "node.json").stat().st_mode), 0o600)
        second = node.new_token()
        self.assertEqual(self.get(url + "/v1/stats", first)[0], 401, "the old one stopped working")
        self.assertEqual(self.get(url + "/v1/stats", second)[0], 200)

    def test_serve_prints_the_token_once(self):
        out = io.StringIO()
        with patch.object(node, "make_server", side_effect=OSError(98, "in use")):
            self.assertEqual(node.serve(18577, "127.0.0.1", out=out), 1)
        self.assertFalse(node.has_token(), "a token is made only once it listens, so it is always shown")


class InstallService(Home):
    def test_a_systemd_user_unit_on_linux(self):
        with patch.dict(os.environ, {"XDG_CONFIG_HOME": str(self.home / "config")}), \
                patch.object(node.platform, "system", return_value="Linux"):
            plan = node.service_plan("install", port=8577, bind="0.0.0.0", platform_name="Linux")
            self.assertTrue(plan["path"].endswith("systemd/user/dgc-node.service"))
            self.assertIn("ExecStart=", plan["content"])
            self.assertIn("node serve --port 8577 --bind 0.0.0.0", plan["content"])
            self.assertIn("WantedBy=default.target", plan["content"])
            self.assertEqual(plan["commands"][-1], ["systemctl", "--user", "enable", "--now", "dgc-node.service"])
            ran = []
            out = io.StringIO()
            self.assertEqual(node.install_service(port=8577, bind="0.0.0.0", system=False, dry_run=False, out=out,
                                                  runner=lambda argv: ran.append(argv) or 0), 0)
            self.assertTrue(Path(plan["path"]).read_text().startswith("[Unit]"))
            self.assertEqual(ran, plan["commands"])
            self.assertIn("Pairing token (shown once): dgcn_", out.getvalue())
            self.assertIn("loginctl enable-linger", out.getvalue())
            ran.clear()
            node.uninstall_service(system=False, dry_run=False, out=io.StringIO(), runner=lambda argv: ran.append(argv) or 0)
            self.assertFalse(Path(plan["path"]).exists())
            self.assertIn(["systemctl", "--user", "disable", "--now", "dgc-node.service"], ran)

    def test_macos_a_launch_agent_or_with_system_a_launch_daemon_as_this_user(self):
        agent = node.service_plan("install", port=8577, bind="0.0.0.0", platform_name="Darwin")
        self.assertIn("Library/LaunchAgents/com.vibedgc.node.plist", agent["path"])
        self.assertTrue(agent["commands"][-1][:2] == ["launchctl", "bootstrap"])
        value = plistlib.loads(agent["content"])
        self.assertNotIn("UserName", value)
        self.assertTrue(any("--system" in note for note in agent["notes"]), "says what to do for an SSH-only Mac")
        daemon = node.service_plan("install", port=8577, bind="0.0.0.0", system=True, platform_name="Darwin")
        self.assertEqual(daemon["path"], "/Library/LaunchDaemons/com.vibedgc.node.plist")
        value = plistlib.loads(daemon["content"])
        self.assertEqual(value["UserName"], node.getpass.getuser(), "a LaunchDaemon that runs as the user")
        self.assertEqual(value["EnvironmentVariables"]["HOME"], str(Path.home()), "its token file is the user's")
        self.assertTrue(value["RunAtLoad"] and value["KeepAlive"])
        self.assertEqual(value["ProgramArguments"][-5:], ["serve", "--port", "8577", "--bind", "0.0.0.0"])
        self.assertEqual(daemon["commands"][-1], ["sudo", "launchctl", "bootstrap", "system", daemon["path"]])

    def test_print_does_nothing(self):
        out = io.StringIO()
        with patch.object(node.platform, "system", return_value="Linux"), \
                patch.object(node.subprocess, "run", side_effect=AssertionError("ran something")):
            self.assertEqual(node.install_service(port=18577, bind="127.0.0.1", system=False, dry_run=True, out=out), 0)
        self.assertIn("--port 18577 --bind 127.0.0.1", out.getvalue())
        self.assertFalse(node.has_token(), "no token made for a dry run")


class Command(Home):
    def test_dgc_node_is_a_subcommand(self):
        from dgc import cli
        self.assertIn("node", cli.SUBCOMMAND_USAGE)
        with patch.object(node, "main", return_value=0) as called:
            self.assertEqual(cli.main(["node", "stats"]), 0)
        called.assert_called_once_with(["stats"])

    def test_it_runs_from_a_bare_copy_of_its_package(self):
        source = Path(node.__file__).read_text()
        imports = {line.split()[1].split(".")[0] for line in source.splitlines()
                   if line.startswith(("import ", "from ")) and not line.startswith("from __future__")}
        self.assertTrue(imports <= set(sys.stdlib_module_names), imports - set(sys.stdlib_module_names))


if __name__ == "__main__":
    unittest.main()
