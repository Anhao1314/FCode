# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for the FCode desktop bundle.

The runtime and console are staged into ``_stage/repo`` and shipped as data:
the app imports the Python package from that read-only copy at run time, so the
zero-dependency runtime keeps working without being frozen module-by-module.
"""
import shutil
import sys
from pathlib import Path

DESKTOP = Path(SPECPATH).resolve()
ROOT = DESKTOP.parent
STAGE = DESKTOP / "_stage"

if STAGE.exists():
    shutil.rmtree(STAGE)

viewer_src = ROOT / "flowcredit" / "viewer"
repo_dir = STAGE / "repo" / "flowcredit"
repo_dir.mkdir(parents=True)
shutil.copytree(ROOT / "flowcredit" / "src", repo_dir / "src")

viewer_dir = repo_dir / "viewer"
viewer_dir.mkdir()
for name in (
    "index.html", "app.css", "design.css", "app.js", "report.js",
    "icons-doodle.js", "server.py",
):
    shutil.copy2(viewer_src / name, viewer_dir / name)
core = viewer_src / "core"
if core.exists():
    shutil.copytree(core, viewer_dir / "core")
traces = viewer_src / "traces"
if traces.exists():
    shutil.copytree(traces, viewer_dir / "traces")

a = Analysis(
    [str(DESKTOP / "app.py")],
    pathex=[str(DESKTOP)],
    binaries=[],
    datas=[(str(STAGE / "repo"), "repo")],
    hiddenimports=[
        # server.py and the flowagent package are loaded from disk at runtime,
        # so PyInstaller cannot see their imports. C extensions must be named.
        "sqlite3",
        "_sqlite3",
        "hashlib",
        "_hashlib",
        "hmac",
        "zlib",
        "binascii",
        "ssl",
        "_ssl",
    ] + (["webview.platforms.cocoa"] if sys.platform == "darwin" else []),
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="FCode",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
coll = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name="FCode")

if sys.platform == "darwin":
    app = BUNDLE(
        coll,
        name="FCode.app",
        icon=None,
        bundle_identifier="com.flowcredit.fcode",
        info_plist={
            "CFBundleName": "FCode",
            "CFBundleDisplayName": "FCode",
            "CFBundleShortVersionString": "0.3.0",
            "CFBundleVersion": "0.3.0",
            "NSHighResolutionCapable": True,
            "LSMinimumSystemVersion": "12.0",
        },
    )
