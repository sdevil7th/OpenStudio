#!/usr/bin/env python3
"""Stage, validate and atomically select an optional compiler runtime on Windows.

Standard generation and model files are read-only inputs. Each installation has
an owned slot; failed or cancelled candidates never replace the active marker.
"""
import argparse
from collections import deque
import hashlib
import json
import os
from pathlib import Path, PureWindowsPath
import re
import shutil
import subprocess
import sys
import threading
import time
from urllib.request import urlopen
import uuid
import zipfile

sys.path.insert(0,str(Path(__file__).resolve().parent))
from ai_compiler_profile import BOOTSTRAP, PROFILE, REQUIREMENTS_SHA256, TORCH_PACKAGES, requirements_path

GIB=1024**3
SLOT_PATTERN=re.compile(r"compiler-runtime-[a-f0-9]{32}")


def atomic_json(path, data):
    temporary=path.with_name(path.name+"."+uuid.uuid4().hex+".tmp")
    with temporary.open("w",encoding="utf-8") as stream:
        json.dump(data,stream,indent=2);stream.flush();os.fsync(stream.fileno())
    temporary.replace(path)


def published_slot(root):
    marker=root/"active.json"
    if not marker.is_file() or marker.is_symlink() or marker.stat().st_size>16384:return None
    data=json.loads(marker.read_text(encoding="utf-8"))
    name=data.get("slot","")
    if data.get("schemaVersion")!=1 or not SLOT_PATTERN.fullmatch(name):return None
    slot=root/name
    if slot.is_symlink() or slot.resolve().parent!=root.resolve():return None
    return slot if slot.is_dir() else None


def active_slot(root):
    slot=published_slot(root)
    if slot is None:return None
    if json.loads((root/"active.json").read_text(encoding="utf-8")).get("profile")!=PROFILE:return None
    ready=slot/"ready.json"
    if not ready.is_file() or ready.stat().st_size>65536:return None
    receipt=json.loads(ready.read_text(encoding="utf-8"))
    if (receipt.get("profile")!=PROFILE or receipt.get("requirementsSha256")!=REQUIREMENTS_SHA256
            or receipt.get("validation")!="pass"):return None
    return slot


def remove_owned_slot(slot, root):
    import psutil
    if (slot.is_symlink() or slot.resolve().parent!=root.resolve()
            or not SLOT_PATTERN.fullmatch(slot.name)):
        raise ValueError("Compiler cleanup escaped its owned root")
    marker=slot/"owner.json"
    if marker.is_symlink() or marker.stat().st_size>2048:raise ValueError("Invalid compiler slot ownership")
    owner=json.loads(marker.read_text(encoding="utf-8"))
    if owner.get("kind")!="openstudio-compiler-slot-v1":raise ValueError("Unknown compiler slot owner")
    try:
        if abs(psutil.Process(owner["pid"]).create_time()-owner["birth"])<.01:
            raise RuntimeError("Compiler setup still owns this slot")
    except psutil.NoSuchProcess:pass
    for process in psutil.process_iter(["exe","name"]):
        executable=process.info.get("exe")
        if executable and Path(executable).resolve().is_relative_to(slot.resolve()):
            raise RuntimeError("Compiler slot is still in use")
        if not executable and (process.info.get("name") or "").lower() in {"python.exe","pythonw.exe"}:
            raise RuntimeError("Cannot verify compiler process retirement")
    paths=list(slot.rglob("*"))
    if len(paths)>128000 or any(p.is_symlink() or not p.resolve().is_relative_to(slot.resolve()) for p in paths):
        raise ValueError("Compiler slot contains unsupported paths")
    # Marker last: retain ownership if antivirus or a mapped DLL still locks data.
    for path in sorted(paths,key=lambda p:len(p.parts),reverse=True):
        if path==marker:continue
        path.rmdir() if path.is_dir() else path.unlink()
    marker.unlink();slot.rmdir()


def extract_bootstrap(archive, destination):
    digest=hashlib.sha256()
    with archive.open("rb") as stream:
        for block in iter(lambda:stream.read(1024**2),b""):digest.update(block)
    if archive.stat().st_size!=BOOTSTRAP["size"] or digest.hexdigest()!=BOOTSTRAP["sha256"]:
        raise ValueError("Compiler bootstrap archive integrity check failed")
    unpack=destination.parent/"unpack";unpack.mkdir()
    with zipfile.ZipFile(archive) as bundle:
        for entry in bundle.infolist():
            name=entry.filename.replace("\\","/")
            if (PureWindowsPath(name).drive or name.startswith("/") or ".." in Path(name).parts
                    or (entry.external_attr>>16)&0o170000==0o120000
                    or not (unpack/name).resolve().is_relative_to(unpack.resolve())):
                raise ValueError("Unsafe compiler bootstrap archive path")
        bundle.extractall(unpack)
    markers=list(unpack.rglob(".openstudio-ai-runtime.json"))
    if len(markers)!=1:raise ValueError("Unexpected compiler bootstrap layout")
    source=markers[0].parent
    if not source.resolve().is_relative_to(unpack.resolve()) or destination.resolve().parent!=unpack.resolve().parent:
        raise ValueError("Compiler bootstrap move escaped staging")
    source.rename(destination)
    unpack.rmdir()


def run(command, log, environment, timeout=3600):
    print("Preparing: "+("validating generation" if "qualify_generation_worker.py" in " ".join(command) else "runtime packages"),flush=True)
    process=subprocess.Popen(command,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,env=environment,
        creationflags=getattr(subprocess,"CREATE_NO_WINDOW",0))
    tail=deque(maxlen=32);failure=[]
    def drain():
        count=0
        try:
            while True:
                block=process.stdout.read(16384)
                if not block:break
                tail.append(block)
                if count<8*1024**2:
                    log.write(block[:8*1024**2-count]);log.flush()
                count+=len(block)
        except Exception as error:failure.append(error)
    reader=threading.Thread(target=drain,daemon=True);reader.start()
    try:code=process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        import psutil
        for child in reversed(psutil.Process(process.pid).children(recursive=True)):
            try:child.kill()
            except psutil.NoSuchProcess:pass
        process.kill();process.wait(timeout=15);raise
    reader.join(timeout=15)
    if reader.is_alive() or failure:raise RuntimeError("Compiler setup output did not drain cleanly")
    if code:raise RuntimeError("Compiler setup command failed: "+b"".join(tail).decode("utf-8",errors="replace")[-2048:])


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root",required=True,type=Path)
    parser.add_argument("--model-root",type=Path)
    parser.add_argument("--archive-cache",type=Path)
    parser.add_argument("--probe-runtime",action="store_true")
    args=parser.parse_args()
    if sys.platform!="win32":raise ValueError("Optional compilation setup is qualified only on Windows NVIDIA")
    requirements=requirements_path()
    if args.probe_runtime:
        import torch
        from ai_compiler_profile import validate_compiler_device
        validate_compiler_device(torch,"cuda:0")
        from importlib import metadata
        prefix=Path(sys.executable).resolve().parent
        if any(not Path(d._path).resolve().is_relative_to(prefix) for d in metadata.distributions()):
            raise ValueError("Compiler runtime borrows external packages")
        print("Compiler runtime prerequisites passed",flush=True);return 0
    if not args.model_root or not (args.model_root/"model_index.json").is_file():
        raise ValueError("Install the Original Stable Audio model before preparing compilation")
    import psutil
    from filelock import FileLock
    root=args.root.resolve();root.mkdir(parents=True,exist_ok=True)
    with FileLock(str(root/"setup.lock"),timeout=0):
        previous=published_slot(root)
        for slot in root.glob("compiler-runtime-*"):
            if slot!=previous and SLOT_PATTERN.fullmatch(slot.name):remove_owned_slot(slot,root)
        occupied=sum(p.stat().st_size for p in root.rglob("*") if p.is_file())
        if occupied+12*GIB>32*GIB or shutil.disk_usage(root).free<20*GIB:
            raise RuntimeError("Compiler setup needs 20 GiB free and space in its 32 GiB cache budget")
        slot=root/("compiler-runtime-"+uuid.uuid4().hex);slot.mkdir()
        atomic_json(slot/"owner.json",{"kind":"openstudio-compiler-slot-v1","pid":os.getpid(),"birth":psutil.Process().create_time()})
        downloads=root/"downloads";downloads.mkdir(exist_ok=True)
        archive=(args.archive_cache or downloads)/BOOTSTRAP["filename"]
        if not archive.is_file():
            archive.parent.mkdir(parents=True,exist_ok=True)
            partial=archive.with_suffix(".part")
            with urlopen(BOOTSTRAP["url"],timeout=60) as response, partial.open("wb") as output:
                count=0
                for block in iter(lambda:response.read(1024**2),b""):
                    count+=len(block)
                    if count>BOOTSTRAP["size"]:raise ValueError("Compiler bootstrap exceeded expected size")
                    output.write(block)
            partial.replace(archive)
        extract_bootstrap(archive,slot/"runtime")
        python=slot/"runtime/python/python.exe"
        environment=dict(os.environ,PIP_CACHE_DIR=str(downloads/"pip"),PIP_DISABLE_PIP_VERSION_CHECK="1",PIP_PROGRESS_BAR="off",PYTHONUTF8="1",PYTHONNOUSERSITE="1")
        temporary=downloads/"temporary";temporary.mkdir(exist_ok=True)
        environment["TMP"]=str(temporary);environment["TEMP"]=str(temporary)
        environment.pop("PYTHONPATH",None);environment.pop("PYTHONHOME",None)
        for name in ("PIP_INDEX_URL","PIP_EXTRA_INDEX_URL","PIP_FIND_LINKS"):
            environment.pop(name,None)
        environment["PIP_CONFIG_FILE"]=os.devnull
        with (slot/"setup.log").open("wb") as log:
            run([str(python),"-m","pip","install","--only-binary=:all:","--no-deps","--index-url","https://download.pytorch.org/whl/cu128",*TORCH_PACKAGES],log,environment)
            run([str(python),"-m","pip","install","--index-url","https://pypi.org/simple","--no-deps","--no-build-isolation","-r",str(requirements)],log,environment)
            run([str(python),"-m","pip","check"],log,environment,120)
            run([str(python),str(Path(__file__).resolve()),"--root",str(root),"--probe-runtime"],log,environment,120)
            run([str(python),str(Path(__file__).with_name("qualify_generation_worker.py")),"--model","stable-audio-3-medium",
                "--model-root",str(args.model_root.resolve()),"--optimization","compile","--durations","30","30",
                "--output-dir",str(slot/"validation"),"--timeout","600"],log,environment,1300)
        report=json.loads((slot/"validation/report.json").read_text(encoding="utf-8"))
        if report.get("status")!="pass" or not report.get("workerRetired") or report.get("gracefulShutdown")!="pass":
            raise RuntimeError("Compiler worker did not validate and retire")
        for row in report["runs"]:
            proof=row["terminal"]["generationDetails"]["execution"].get("compilation",{})
            if proof.get("state")!="pass" or not proof.get("observedRegions"):
                raise RuntimeError("Compiler validation observed no real compiled region")
        atomic_json(slot/"ready.json",{"profile":PROFILE,"requirementsSha256":REQUIREMENTS_SHA256,"validation":"pass",
            "workerVersion":report["ready"]["scriptVersion"],"audioQuality":"not_asserted for setup output"})
        atomic_json(root/"active.json",{"schemaVersion":1,"profile":PROFILE,"slot":slot.name})
        print(json.dumps({"state":"complete","profile":PROFILE,"runtime":str(slot/"runtime"),"standardRuntimeChanged":False}),flush=True)
    return 0


if __name__=="__main__":
    try:raise SystemExit(main())
    except Exception as error:
        print("Compiler setup failed; previous runtime retained: "+str(error),file=sys.stderr,flush=True)
        raise SystemExit(1)
