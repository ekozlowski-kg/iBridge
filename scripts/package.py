#!/usr/bin/env python3
"""Repackage the audited 0.6.0 runtime with the 0.6.1 application sources.
No document directories or user state are read by this script.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import tempfile
import zipfile

BASELINE_SHA256 = '7b54108bb31cd597d378119ef4ac002c9c9f0d8b1da947321794814d5208e5fe'
ROOT = Path(__file__).resolve().parents[1]

def run(*args):
    subprocess.run([str(a) for a in args], check=True)

def extract_app(archive, stage):
    with zipfile.ZipFile(archive) as z:
        for item in z.infolist():
            parts = Path(item.filename).parts
            if item.filename.startswith('__MACOSX') or '.DS_Store' in parts:
                continue
            at = next((i for i,p in enumerate(parts) if p == 'EZD - iBridge.app'), None)
            if at is None:
                continue
            relative = Path(*parts[at:])
            if '..' in relative.parts or relative.is_absolute():
                raise ValueError('Invalid archive path')
            target = stage / relative
            if item.is_dir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            mode = item.external_attr >> 16
            if (mode & 0o170000) == 0o120000:
                link = z.read(item).decode('utf-8')
                resolved = (target.parent / link).resolve()
                if not resolved.is_relative_to(stage.resolve()):
                    raise ValueError('Archive symlink escapes build directory')
                target.symlink_to(link)
            else:
                target.write_bytes(z.read(item))
                target.chmod(mode & 0o777 or 0o644)
    return stage / 'EZD - iBridge.app'

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--baseline', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    actual = hashlib.sha256(args.baseline.read_bytes()).hexdigest()
    if actual != BASELINE_SHA256:
        raise ValueError('Baseline SHA-256 does not match the audited 0.6.0 package')
    version = json.loads((ROOT / 'package.json').read_text())['version']
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    name = f'EZD-iBridge-{version}-macOS-arm64-testy-wewnetrzne'
    archive = output / f'{name}.zip'
    if archive.exists():
        raise FileExistsError(f'Refusing to replace {archive}')
    scratch = ROOT / 'work' / 'packaging'
    scratch.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='ibridge-package-', dir=scratch) as temp:
        stage = Path(temp) / name
        stage.mkdir()
        app = extract_app(args.baseline, stage)
        if not app.is_dir():
            raise ValueError('Application is missing from the baseline')
        source_target = app / 'Contents/Resources/app'
        for directory in ['electron', 'dist']:
            shutil.rmtree(source_target / directory)
            shutil.copytree(ROOT / directory, source_target / directory)
        shutil.copyfile(ROOT / 'package.json', source_target / 'package.json')
        for plist_path in app.rglob('*.app/Contents/Info.plist'):
            contents = plistlib.loads(plist_path.read_bytes())
            contents['CFBundleShortVersionString'] = version
            contents['CFBundleVersion'] = version
            plist_path.write_bytes(plistlib.dumps(contents))
        info_path = app / 'Contents/Info.plist'
        info = plistlib.loads(info_path.read_bytes())
        info.update(CFBundleShortVersionString=version, CFBundleVersion=version,
            NSAppleEventsUsageDescription='iBridge sprawdza, czy dokument jest nadal otwarty w Wordzie, aby po jego zamknięciu automatycznie zakończyć edycję w EZD.')
        info_path.write_bytes(plistlib.dumps(info))
        # The runtime and signing sidecar are unchanged. Only helper app metadata
        # and the outer app change, so re-sign those bundles, deepest first.
        for nested in sorted(app.rglob('*.app'), key=lambda p: len(p.parts), reverse=True):
            run('/usr/bin/codesign', '--force', '--sign', '-', '--timestamp=none', nested)
        entitlements = Path(temp) / 'automation.plist'
        entitlements.write_bytes(plistlib.dumps({'com.apple.security.automation.apple-events': True}))
        run('/usr/bin/codesign', '--force', '--sign', '-', '--timestamp=none', '--entitlements', entitlements, app)
        run('/usr/bin/codesign', '--verify', '--deep', '--strict', app)
        shutil.copyfile(ROOT / 'docs/TESTY-WEWNETRZNE.txt', stage / 'INSTRUKCJA.txt')
        files = [p for p in (ROOT/'electron').glob('*.cjs')] + [p for p in (ROOT/'dist').glob('*') if p.is_file()]
        manifest = {'version': version, 'baselineSha256': actual, 'signing': 'ad-hoc; not Apple Developer ID; not notarized',
            'sourceRepository': 'https://github.com/ekozlowski-kg/iBridge',
            'files': {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(files)},
            'unchangedSignerSha256': hashlib.sha256((source_target/'signer/ibridge-signer.jar').read_bytes()).hexdigest()}
        (stage/'BUILD-INFO.json').write_text(json.dumps(manifest, indent=2)+'\n')
        run('/usr/bin/ditto', '-c', '-k', '--norsrc', '--keepParent', stage, archive)
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    (output/f'{name}.sha256').write_text(f'{digest}  {archive.name}\n')
    print(archive)
    print('SHA-256:', digest)

if __name__ == '__main__':
    main()
