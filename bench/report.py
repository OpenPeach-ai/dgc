#!/usr/bin/env python3
"""Print the aggregate pass@1/pass@2 table for a results jsonl.
Usage: python3 report.py results/results-<model>-<tag>.jsonl
"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from run_bench import print_report

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("usage: python3 report.py <results.jsonl>"); sys.exit(1)
    print_report(Path(sys.argv[1]))
