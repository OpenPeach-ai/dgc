"""What the hardware exporters and tools DGC Router reads actually answer, trimmed, for the hardware tests.

node_exporter, the DCGM exporter and Glances were read live on an NVIDIA GB10 (unified memory) box and rocminfo and
amdgpu's sysfs counters on an AMD Radeon 8060S (an APU); host names and ids are replaced. The AMD device-metrics
exporter, Netdata, amd-smi, rocm-smi, nvidia-smi on a card, and macOS's vm_stat and ioreg replay their documented
output. A small fake HTTP server serves any of them (and a dgc node) on 127.0.0.1.
"""
from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

GIB = 1024 ** 3

NODE_EXPORTER = """# HELP node_memory_MemTotal_bytes Memory information field MemTotal_bytes.
# TYPE node_memory_MemTotal_bytes gauge
node_memory_MemTotal_bytes 1.2852430848e+11
node_memory_MemAvailable_bytes 8.6624342016e+10
node_load1 2.39
node_cpu_seconds_total{cpu="0",mode="idle"} 582715.07
node_cpu_seconds_total{cpu="0",mode="iowait"} 1666.8
node_cpu_seconds_total{cpu="0",mode="system"} 22804.58
node_cpu_seconds_total{cpu="0",mode="user"} 59322.16
node_cpu_seconds_total{cpu="1",mode="idle"} 584347.58
node_cpu_seconds_total{cpu="1",mode="iowait"} 1432.25
node_cpu_seconds_total{cpu="1",mode="system"} 23303.6
node_cpu_seconds_total{cpu="1",mode="user"} 61186.05
node_hwmon_temp_celsius{chip="nvme_nvme0",sensor="temp1"} 46.85
node_uname_info{machine="aarch64",nodename="gpu-box",sysname="Linux"} 1
"""

# node_exporter on macOS: no MemAvailable; free + inactive is what can be had.
NODE_EXPORTER_DARWIN = """node_memory_total_bytes 6.8719476736e+10
node_memory_free_bytes 4.294967296e+09
node_memory_inactive_bytes 1.7179869184e+10
node_load1 1.5
"""

# node_exporter's drm collector on an AMD APU (a 2 GiB carve-out and a 105 GiB GTT), with the amdgpu hwmon.
NODE_EXPORTER_DRM_APU = f"""node_memory_MemTotal_bytes 1.32573396992e+11
node_memory_MemAvailable_bytes 9.4908325888e+10
node_drm_card_info{{card="card0",memory_vendor="",power_performance_level="auto",unique_id="",vendor="amd"}} 1
node_drm_gpu_busy_percent{{card="card0"}} 12
node_drm_memory_vram_size_bytes{{card="card0"}} {2 * GIB}
node_drm_memory_vram_used_bytes{{card="card0"}} 171425792
node_drm_memory_gtt_size_bytes{{card="card0"}} 112742891520
node_drm_memory_gtt_used_bytes{{card="card0"}} 7129608192
node_hwmon_chip_names{{chip="0000:f4:00_0",chip_name="amdgpu"}} 1
node_hwmon_temp_celsius{{chip="0000:f4:00_0",sensor="temp1"}} 30
"""

# NVIDIA's DCGM exporter on a GB10: no frame-buffer fields (its memory is the computer's).
DCGM_GB10 = """# HELP DCGM_FI_DEV_GPU_TEMP GPU temperature (in C).
# TYPE DCGM_FI_DEV_GPU_TEMP gauge
DCGM_FI_DEV_GPU_TEMP{gpu="0",UUID="GPU-00000000-0000-0000-0000-000000000001",pci_bus_id="0000000F:01:00.0",device="nvidia0",modelName="NVIDIA GB10",Hostname="gpu-box",DCGM_FI_DRIVER_VERSION="580.95.05"} 46
# HELP DCGM_FI_DEV_POWER_USAGE Power draw (in W).
DCGM_FI_DEV_POWER_USAGE{gpu="0",UUID="GPU-00000000-0000-0000-0000-000000000001",pci_bus_id="0000000F:01:00.0",device="nvidia0",modelName="NVIDIA GB10",Hostname="gpu-box",DCGM_FI_DRIVER_VERSION="580.95.05"} 11.972000
DCGM_FI_DEV_GPU_UTIL{gpu="0",UUID="GPU-00000000-0000-0000-0000-000000000001",pci_bus_id="0000000F:01:00.0",device="nvidia0",modelName="NVIDIA GB10",Hostname="gpu-box",DCGM_FI_DRIVER_VERSION="580.95.05"} 34
DCGM_FI_DEV_SM_CLOCK{gpu="0",UUID="GPU-00000000-0000-0000-0000-000000000001",device="nvidia0",modelName="NVIDIA GB10",Hostname="gpu-box"} 2398
"""

# Two RTX 3090s: frame buffer used / free / reserved in MiB.
DCGM_TWO_CARDS = "\n".join(
    f'DCGM_FI_DEV_{name}{{gpu="{gpu}",UUID="GPU-{gpu}",device="nvidia{gpu}",modelName="NVIDIA GeForce RTX 3090",'
    f'Hostname="gpu-box"}} {value}'
    for gpu, values in ((0, {"FB_USED": 18000, "FB_FREE": 6000, "FB_RESERVED": 576, "GPU_UTIL": 40, "GPU_TEMP": 61,
                             "POWER_USAGE": 300.5}),
                        (1, {"FB_USED": 6000, "FB_FREE": 18000, "FB_RESERVED": 576, "GPU_UTIL": 20, "GPU_TEMP": 55,
                             "POWER_USAGE": 150.25}))
    for name, value in values.items()) + "\n"

# AMD's device-metrics exporter (its documented metric names; VRAM in MB as amd-smi counts them).
AMD_EXPORTER = """# HELP gpu_gfx_activity Graphics engine usage percentage
gpu_gfx_activity{gpu_id="0",serial_number="X",card_model="AMD Instinct MI300X",hostname="gpu-box"} 55
gpu_total_vram{gpu_id="0",serial_number="X",card_model="AMD Instinct MI300X",hostname="gpu-box"} 196592
gpu_used_vram{gpu_id="0",serial_number="X",card_model="AMD Instinct MI300X",hostname="gpu-box"} 98296
gpu_edge_temperature{gpu_id="0",serial_number="X",card_model="AMD Instinct MI300X",hostname="gpu-box"} 0
gpu_junction_temperature{gpu_id="0",serial_number="X",card_model="AMD Instinct MI300X",hostname="gpu-box"} 48
gpu_package_power{gpu_id="0",serial_number="X",card_model="AMD Instinct MI300X",hostname="gpu-box"} 412
"""

# Glances' REST API 4 on the GB10 box (its GPU's memory is null: it is the computer's).
GLANCES = {
    "status": {"version": "4.5.8"},
    "mem": {"total": 128524308480, "available": 86460973056, "percent": 32.7, "used": 42063335424},
    "cpu": {"total": 12.5, "user": 8.0, "system": 4.5, "idle": 87.5, "cpucore": 20, "time_since_update": 2.0},
    "load": {"min1": 2.47, "min5": 2.8, "min15": 3.47, "cpucore": 20},
    "gpu": [{"key": "gpu_id", "gpu_id": "nvidia0", "name": "NVIDIA GB10", "mem": None, "proc": 0, "temperature": 46,
             "fan_speed": None}],
    "quicklook": {"cpu_name": "ARM Limited", "cpu": 12.5},
}

# Netdata's API v1: info, the system charts, and the go.d nvidia_smi collector's GPU charts.
NETDATA_INFO = {"version": "v2.4.0", "cores_total": "16", "ram_total": str(64 * GIB), "mirrored_hosts": ["nas"]}
NETDATA_DATA = {
    "system.cpu": {"labels": ["time", "guest_nice", "guest", "steal", "softirq", "irq", "user", "system", "nice",
                              "iowait"], "data": [[1793500000, 0, 0, 0, 0.5, 0, 20.0, 5.0, 0, 0.5]]},
    "system.load": {"labels": ["time", "load1", "load5", "load15"], "data": [[1793500000, 1.25, 1.0, 0.9]]},
    "mem.available": {"labels": ["time", "avail"], "data": [[1793500000, 40960.0]]},
    "nvidia_smi.gpu_GPU-1_frame_buffer_memory_usage": {"labels": ["time", "free", "used", "reserved"],
                                                        "data": [[1793500000, 10 * GIB, 5 * GIB, 1 * GIB]]},
    "nvidia_smi.gpu_GPU-1_gpu_utilization": {"labels": ["time", "gpu"], "data": [[1793500000, 77]]},
    "nvidia_smi.gpu_GPU-1_temperature": {"labels": ["time", "temperature"], "data": [[1793500000, 64]]},
    "nvidia_smi.gpu_GPU-1_power_draw": {"labels": ["time", "power_draw"], "data": [[1793500000, 61.5]]},
}
NETDATA_CHARTS = {"charts": {
    "system.cpu": {"context": "system.cpu"},
    "nvidia_smi.gpu_GPU-1_frame_buffer_memory_usage": {
        "context": "nvidia_smi.gpu_frame_buffer_memory_usage",
        "chart_labels": {"uuid": "GPU-1", "product_name": "NVIDIA RTX PRO 2000 Blackwell"}},
    "nvidia_smi.gpu_GPU-1_gpu_utilization": {"context": "nvidia_smi.gpu_utilization",
                                             "chart_labels": {"uuid": "GPU-1", "product_name": "NVIDIA RTX PRO 2000 Blackwell"}},
    "nvidia_smi.gpu_GPU-1_temperature": {"context": "nvidia_smi.gpu_temperature",
                                         "chart_labels": {"uuid": "GPU-1", "product_name": "NVIDIA RTX PRO 2000 Blackwell"}},
    "nvidia_smi.gpu_GPU-1_power_draw": {"context": "nvidia_smi.gpu_power_draw",
                                        "chart_labels": {"uuid": "GPU-1", "product_name": "NVIDIA RTX PRO 2000 Blackwell"}},
}}

NVIDIA_SMI_GB10 = "NVIDIA GB10, [N/A], [N/A], 0, 46, 11.99\n"
NVIDIA_SMI_CARDS = ("NVIDIA GeForce RTX 4090, 24564, 18000, 34, 61, 287.5\n"
                    "NVIDIA GeForce RTX 4090, 24564, 2000, 3, 40, [N/A]\n")
MEMINFO = "MemTotal:       129466208 kB\nMemFree:         3000000 kB\nMemAvailable:   92738648 kB\nCached: 1 kB\n"
PROC_STAT = "cpu  367057197 25512894 124475899 31749271415 6908821 0 11878237 0 0 0\ncpu0 1 2 3 4 5 6 7 8 9 10\n"
PROC_STAT_LATER = "cpu  367058197 25512894 124476899 31749280415 6908821 0 11878237 0 0 0\n"
LOADAVG = "0.77 0.93 0.77 1/4401 2103467\n"

ROCMINFO = """ROCk module is loaded
=====================
HSA Agents
=====================
*******
Agent 1
*******
  Name:                    AMD Ryzen 9 7950X
  Uuid:                    CPU-XX
  Marketing Name:          AMD Ryzen 9 7950X
  Vendor Name:             CPU
  Device Type:             CPU
*******
Agent 2
*******
  Name:                    gfx1151
  Uuid:                    GPU-XX
  Marketing Name:          Radeon 8060S Graphics
  Vendor Name:             AMD
  Device Type:             GPU
*** Done ***
"""

AMD_SMI_METRIC = json.dumps({"gpu_data": [{
    "gpu": 0, "usage": {"gfx_activity": {"value": 21, "unit": "%"}},
    "power": {"socket_power": {"value": 305, "unit": "W"}},
    "temperature": {"edge": {"value": "N/A", "unit": "C"}, "hotspot": {"value": 52, "unit": "C"}},
    "mem_usage": {"total_vram": {"value": 196592, "unit": "MB"}, "used_vram": {"value": 1024, "unit": "MB"}}}]})
AMD_SMI_STATIC = json.dumps([{"gpu": 0, "asic": {"market_name": "AMD Instinct MI300X", "vendor_id": "0x1002"}}])
ROCM_SMI = json.dumps({"card0": {"GPU use (%)": "7", "Temperature (Sensor edge) (C)": "44.0",
                                 "Average Graphics Package Power (W)": "35.0", "VRAM Total Memory (B)": "17163091968",
                                 "VRAM Total Used Memory (B)": "1073741824"}})
ROCM_SMI_NAMES = json.dumps({"card0": {"Card Series": "Radeon RX 7800 XT", "Card Model": "0x747e"}})

VM_STAT = """Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               50000.
Pages active:                            900000.
Pages inactive:                          600000.
Pages speculative:                        10000.
Pages throttled:                              0.
Pages wired down:                        400000.
Pages purgeable:                          40000.
"""
IOREG_ACCELERATOR = """+-o AGXAcceleratorG14X  <class AGXAcceleratorG14X, id 0x100000a1c, registered, matched, active, busy 0>
    {
      "model" = "Apple M2 Ultra"
      "gpu-core-count" = 76
      "PerformanceStatistics" = {"In use system memory (driver)"=0,"Alloc system memory"=40000000000,"Tiler Utilization %"=3,"recoveryCount"=0,"Renderer Utilization %"=10,"Device Utilization %"=12,"In use system memory"=38654705664}
    }
"""


class FakeHardware:
    """One fake on 127.0.0.1: ``kind`` is dcgm, node_exporter, amd, prometheus_other, glances, netdata, dgc_node or
    redirect. A dgc node wants ``token``; ``stats`` is what it serves. ``reads`` counts the requests."""

    def __init__(self, kind: str, *, page: str = "", token: str = "", stats: dict | None = None):
        self.kind, self.page, self.token = kind, page, token
        self.stats = stats or {"dgc_node": 1, "gpus": [{"name": "NVIDIA GeForce RTX 4090", "memory_total_bytes":
                                                        24 * GIB, "memory_used_bytes": 18 * GIB, "util_pct": 34.0,
                                                        "temp_c": 61.0, "power_w": 287.5}],
                                "memory": {"total_bytes": 64 * GIB, "available_bytes": 40 * GIB},
                                "cpu": {"cores": 16, "load1": 1.0, "util_pct": 7.5}, "os": "linux"}
        self.reads: list[dict] = []
        self.lock = threading.Lock()

    def __enter__(self):
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def send(self, status, body, kind="application/json", headers=None):
                data = body.encode() if isinstance(body, str) else json.dumps(body).encode()
                self.send_response(status)
                self.send_header("Content-Type", kind)
                self.send_header("Content-Length", str(len(data)))
                for key, value in (headers or {}).items():
                    self.send_header(key, value)
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self):  # noqa: N802
                parts = urlsplit(self.path)
                with fake.lock:
                    fake.reads.append({"path": parts.path, "query": parts.query,
                                       "auth": self.headers.get("Authorization", "")})
                kind = fake.kind
                if kind == "redirect":
                    return self.send(302, "", headers={"Location": "http://example.invalid/metrics"})
                if kind in ("dcgm", "node_exporter", "amd", "prometheus_other") and parts.path == "/metrics":
                    return self.send(200, fake.page, "text/plain; version=0.0.4")
                if kind == "glances" and parts.path.startswith("/api/4/"):
                    name = parts.path.rsplit("/", 1)[-1]
                    return self.send(200, GLANCES[name]) if name in GLANCES else self.send(404, {"detail": "no"})
                if kind == "netdata" and parts.path == "/api/v1/info":
                    return self.send(200, NETDATA_INFO)
                if kind == "netdata" and parts.path == "/api/v1/charts":
                    return self.send(200, NETDATA_CHARTS)
                if kind == "netdata" and parts.path == "/api/v1/data":
                    chart = dict(item.split("=", 1) for item in parts.query.split("&") if "=" in item).get("chart")
                    return self.send(200, NETDATA_DATA[chart]) if chart in NETDATA_DATA else self.send(404, {})
                if kind == "dgc_node" and parts.path == "/v1/stats":
                    if self.headers.get("Authorization", "") != f"Bearer {fake.token}":
                        return self.send(401, {"dgc_node": 1, "error": "a pairing token is needed"},
                                         headers={"WWW-Authenticate": "Bearer"})
                    return self.send(200, fake.stats)
                return self.send(404, {"error": "not here"})

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        return self

    def __exit__(self, *_):
        self.server.shutdown()
        self.server.server_close()
