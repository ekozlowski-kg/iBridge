#!/usr/bin/env python3
"""Compile the small Node-API bridge inside the signed macOS application."""
import argparse
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
args.output.parent.mkdir(parents=True, exist_ok=True)
subprocess.run(['xcrun', 'clang++', '-std=c++17', '-fobjc-arc', '-DNAPI_VERSION=8',
    '-arch', 'arm64', '-mmacosx-version-min=11.0', '-shared', '-undefined', 'dynamic_lookup',
    '-framework', 'Foundation', '-framework', 'UserNotifications',
    '-I', str(ROOT / 'vendor/node-api'), str(ROOT / 'native/notification-permissions.mm'),
    '-o', str(args.output)], check=True)
subprocess.run(['codesign', '--force', '--sign', '-', '--timestamp=none', str(args.output)], check=True)
