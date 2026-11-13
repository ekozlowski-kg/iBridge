#!/usr/bin/env python3
"""Build a reviewable test copy using an explicitly supplied local 0.6.1 runtime."""
import argparse
import hashlib
import json
from pathlib import Path
import plistlib
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]

def run(*args):
    subprocess.run([str(arg) for arg in args], check=True)

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--runtime', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    runtime = args.runtime.resolve()
    resources = runtime / 'Contents/Resources/app'
    if json.loads((resources / 'package.json').read_text())['version'] != '0.6.1':
        raise ValueError('Expected a local iBridge 0.6.1 runtime')
    if not (resources / 'node_modules/@xmldom/xmldom').is_dir():
        raise ValueError('Missing runtime dependencies')
    version = json.loads((ROOT / 'package.json').read_text())['version']
    args.output.mkdir(parents=True, exist_ok=True)
    output = args.output.resolve()
    name = f'EZD-iBridge-{version}-powiadomienia-test'
    archive = output / f'{name}.zip'
    if archive.exists():
        raise FileExistsError(archive)
    with tempfile.TemporaryDirectory(prefix='inbox-build-', dir=ROOT.parent) as temp:
        stage = Path(temp) / name
        stage.mkdir()
        app = stage / 'EZD - iBridge.app'
        shutil.copytree(runtime, app, symlinks=True)
        target = app / 'Contents/Resources/app'
        for directory in ['electron', 'dist']:
            shutil.rmtree(target / directory)
            shutil.copytree(ROOT / directory, target / directory)
        shutil.copyfile(ROOT / 'package.json', target / 'package.json')
        info_file = app / 'Contents/Info.plist'
        info = plistlib.loads(info_file.read_bytes())
        info.update(CFBundleShortVersionString=version, CFBundleVersion=version)
        info_file.write_bytes(plistlib.dumps(info))
        # Preserve original automation entitlements needed for Word observation.
        entitlements = Path(temp) / 'entitlements.plist'
        entitlements.write_bytes(plistlib.dumps({'com.apple.security.automation.apple-events': True}))
        run('/usr/bin/codesign', '--force', '--sign', '-', '--timestamp=none', '--entitlements', entitlements, app)
        run('/usr/bin/codesign', '--verify', '--deep', '--strict', app)
        manifest = {
            'version': version, 'testBuild': True, 'signing': 'ad-hoc; not notarized',
            'sourceCommit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
            'runtimeSource': 'local installed iBridge 0.6.1',
            'runtimeInfoSha256': digest(runtime / 'Contents/Info.plist'),
            'signerSha256': digest(resources / 'signer/ibridge-signer.jar'),
            'files': {str(p.relative_to(ROOT)): digest(p) for d in ['electron', 'dist'] for p in sorted((ROOT / d).rglob('*')) if p.is_file()},
        }
        (stage / 'BUILD-INFO.json').write_text(json.dumps(manifest, indent=2) + '\n')
        shutil.copyfile(ROOT / 'docs/POWIADOMIENIA.txt', stage / 'INSTRUKCJA.txt')
        run('/usr/bin/ditto', '-c', '-k', '--norsrc', '--keepParent', stage, archive)
    (output / f'{name}.sha256').write_text(f'{digest(archive)}  {archive.name}\n')
    print(archive)

if __name__ == '__main__':
    main()
