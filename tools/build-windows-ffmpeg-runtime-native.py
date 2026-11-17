"""Build the owned Windows runtime using portable pinned tools and Git Bash.

No admin access or global PATH changes. Output is an unpublished development
candidate until the normal runtime release workflow publishes and pins it.
"""
from pathlib import Path
import argparse
import hashlib
import json
import os
import shutil
import subprocess
import zipfile

def digest(path):
    h=hashlib.sha256()
    with path.open('rb') as f:
        while block:=f.read(1024*1024):h.update(block)
    return h.hexdigest()

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--work-root',type=Path,default=Path('build-ffmpeg-runtime-native'))
    parser.add_argument('--output-root',type=Path,default=Path('dist/ffmpeg-runtime-native'))
    parser.add_argument('--jobs',type=int,default=6)
    args=parser.parse_args()
    if os.name!='nt' or not 1<=args.jobs<=32:raise SystemExit('Use Windows and 1–32 build jobs.')
    repo=Path(__file__).resolve().parent.parent
    lock_file=repo/'thirdparty/ffmpeg/source-lock.json'
    if not lock_file.exists():lock_file=repo/'source-lock.json'
    lock=json.loads(lock_file.read_text(encoding='utf-8'))
    bash=Path(os.environ.get('ProgramFiles','C:/Program Files'))/'Git/bin/bash.exe'
    if not bash.is_file():raise SystemExit('Git for Windows with Git Bash is required.')
    root=args.work_root.resolve();root.mkdir(parents=True,exist_ok=True)
    stamp=root/'native-inputs.json';identity={'sourceLockSha256':digest(lock_file),'jobs':args.jobs}
    if stamp.exists() and json.loads(stamp.read_text())['sourceLockSha256']!=identity['sourceLockSha256']:
        raise SystemExit('Source pins changed. Choose a fresh --work-root; existing work is preserved.')
    downloads=root/'downloads';downloads.mkdir(exist_ok=True)
    tools=root/'tools';tools.mkdir(exist_ok=True)
    sources=root/'sources';sources.mkdir(exist_ok=True)
    windows=lock['toolchain']['windows'];assets=[*lock['sources'],*lock['buildTools'],windows,*lock['windowsBuildTools']]
    for asset in assets:
        name=asset['archive']
        if Path(name).name!=name:raise SystemExit('Invalid pinned archive filename.')
        target=downloads/name
        if not target.exists() and (repo/'sources'/name).is_file():
            shutil.copyfile(repo/'sources'/name,target)
        if not target.exists():
            stage=target.with_name(target.name+'.download')
            subprocess.run(['curl.exe','--fail','--location','--retry','2','--output',str(stage),asset['url']],check=True)
            if digest(stage)!=asset['sha256']:raise SystemExit('Downloaded input checksum mismatch: '+name)
            stage.replace(target)
        if digest(target)!=asset['sha256']:raise SystemExit('Cached input checksum mismatch: '+name)
        if asset in lock['sources']:
            destination=sources/asset['name']
            if not destination.exists():
                destination.mkdir();subprocess.run(['tar','-xf',str(target),'-C',str(destination),'--strip-components','1'],check=True)
        elif asset is windows or asset in lock['windowsBuildTools']:
            extracted=tools/(name+'.extracted')
            if not extracted.exists():
                if name.endswith('.zip'):
                    with zipfile.ZipFile(target) as archive:
                        for item in archive.infolist():
                            if not (tools/item.filename).resolve().is_relative_to(tools.resolve()):raise SystemExit('Unsafe tool archive member.')
                        archive.extractall(tools)
                else:subprocess.run(['tar','-xf',str(target),'-C',str(tools)],check=True)
                extracted.write_text(asset['sha256'],encoding='ascii')
    stamp.write_text(json.dumps(identity,indent=2),encoding='utf-8')
    env=os.environ.copy();env.update(OPENSTUDIO_FFMPEG_WORK_ROOT=str(root),OPENSTUDIO_FFMPEG_REPO_ROOT=str(repo),
        OPENSTUDIO_FFMPEG_NATIVE_TOOLCHAIN=str(tools/Path(windows['archive']).stem),
        OPENSTUDIO_FFMPEG_NATIVE_NASM=str(tools/('nasm-'+lock['windowsBuildTools'][0]['version'])),OPENSTUDIO_FFMPEG_BUILD_JOBS=str(args.jobs))
    subprocess.run([str(bash),str(Path(__file__).with_suffix('.sh'))],env=env,check=True)
    from package_ffmpeg_runtime import package
    package(repo,root,args.output_root.resolve(),lock_file)

if __name__=='__main__':main()
