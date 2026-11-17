"""Package a source-built Windows runtime and its complete source as one unit."""
from pathlib import Path
import hashlib
import json
import shutil
import zipfile

def digest(path):
    h=hashlib.sha256()
    with path.open('rb') as f:
        while block:=f.read(1024*1024):h.update(block)
    return h.hexdigest()

def package(repo,work,output,lock_file):
    lock=json.loads(lock_file.read_text(encoding='utf-8'))
    if not output.is_relative_to(repo):raise ValueError('Candidate output must remain inside this checkout.')
    runtime=work/'runtime';source=work/'corresponding-source';runtime.mkdir(exist_ok=True);source.mkdir(exist_ok=True)
    prefix=work/'prefix';configuration='\n'.join((work/'build/ffmpeg'/name).read_text(encoding='utf-8') for name in ['config.h','config_components.h'])
    if '#define CONFIG_H264_MF_ENCODER 1' not in configuration or '#define CONFIG_FFPROBE 1' not in configuration:raise ValueError('Required source-built video features are missing.')
    files=[prefix/'bin/ffmpeg.exe',prefix/'bin/ffprobe.exe',*sorted((prefix/'bin').glob('*.dll'))]
    for file in files:shutil.copy2(file,runtime/file.name)
    size=sum(file.stat().st_size for file in files)
    if size>36*1024**2:raise ValueError('Runtime exceeds the reviewed 36 MiB executable/DLL budget.')
    notices={'ffmpeg/COPYING.LGPLv2.1':'FFmpeg-COPYING.LGPLv2.1.txt','ffmpeg/COPYING.LGPLv3':'FFmpeg-COPYING.LGPLv3.txt','lame/COPYING':'LAME-COPYING.txt','libogg/COPYING':'libogg-COPYING.txt','libvorbis/COPYING':'libvorbis-COPYING.txt'}
    (runtime/'licenses').mkdir(exist_ok=True)
    for name,target in notices.items():shutil.copy2(work/'sources'/name,runtime/'licenses'/target)
    allowed={file.name for file in files}|{'runtime-manifest.json','source-lock.json'}
    if any(p.name not in allowed and p.name!='licenses' for p in runtime.iterdir()):raise ValueError('Unexpected stale runtime contents; choose a fresh work root.')
    manifest={'schemaVersion':1,'runtimeVersion':lock['runtimeVersion'],'target':lock['target'],'license':'LGPL-2.1-or-later','gplComponentsEnabled':False,'nonFreeComponentsEnabled':False,'capabilities':{'ffprobe':True,'h264MediaFoundation':True},'files':[]}
    for file in sorted(p for p in runtime.rglob('*') if p.is_file() and p.name not in ['runtime-manifest.json','source-lock.json']):manifest['files'].append({'path':file.relative_to(runtime).as_posix(),'size':file.stat().st_size,'sha256':digest(file)})
    (runtime/'runtime-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n',encoding='utf-8',newline='\n');shutil.copy2(lock_file,runtime/'source-lock.json')
    (source/'sources').mkdir(exist_ok=True);(source/'build').mkdir(exist_ok=True)
    for item in [*lock['sources'],*lock['buildTools']]:
        archive=work/'downloads'/item['archive']
        if digest(archive)!=item['sha256']:raise ValueError('Corresponding source checksum mismatch.')
        shutil.copy2(archive,source/'sources'/archive.name)
    shutil.copy2(lock_file,source/'source-lock.json')
    patch_root=repo/'thirdparty/ffmpeg/patches'
    if not patch_root.exists():patch_root=repo/'patches'
    shutil.copytree(patch_root,source/'patches',dirs_exist_ok=True)
    script_root=Path(__file__).resolve().parent
    for name in ['build-windows-ffmpeg-runtime-native.py','build-windows-ffmpeg-runtime-native.sh','package_ffmpeg_runtime.py','build-windows-ffmpeg-runtime.sh','test-windows-ffmpeg-runtime.ps1']:
        shutil.copy2(script_root/name,source/'build'/name)
    for name in ['config.h','config_components.h','ffbuild/config.mak']:
        shutil.copy2(work/'build/ffmpeg'/name,source/'build'/('ffmpeg-'+Path(name).name))
    (source/'README.md').write_text('OpenStudio Windows FFmpeg '+lock['runtimeVersion']+' corresponding source.\n\nAll four media-library sources, NASM source, reviewed LAME patch, configuration, build scripts and tool pins are included. GPL/non-free runtime components are disabled. Media Foundation uses Windows system components; no separate H.264 encoder library is shipped.\n\nWindows rebuild: install Git for Windows and Python, then run:\npython build/build-windows-ffmpeg-runtime-native.py --work-root build-native --output-root dist/native\n\nLinux cross-build: bash build/build-windows-ffmpeg-runtime.sh\n\nThe scripts verify included source archives and download only pinned build tools. Release eligibility is recorded separately in the application runtime pin; a local candidate is not a published runtime.\n',encoding='utf-8')
    output.mkdir(parents=True,exist_ok=True)
    archives=[]
    for folder,name in [(runtime,'OpenStudio-FFmpeg-8.0.1-windows-x64.zip'),(source,'OpenStudio-FFmpeg-8.0.1-complete-corresponding-source.zip')]:
        target=output/name
        with zipfile.ZipFile(target,'w',zipfile.ZIP_DEFLATED,compresslevel=9) as archive:
            for file in sorted(p for p in folder.rglob('*') if p.is_file()):archive.write(file,file.relative_to(folder).as_posix())
        archives.append(target)
    candidate={'schemaVersion':1,'status':'development','runtimeVersion':lock['runtimeVersion'],'target':lock['target'],'runtimeManifestSha256':digest(runtime/'runtime-manifest.json'),'sourceLockSha256':digest(lock_file),'assets':{}}
    for key,file in zip(['runtime','correspondingSource'],archives):candidate['assets'][key]={'name':file.name,'path':file.relative_to(repo).as_posix(),'sha256':digest(file)}
    candidate_file=repo/'thirdparty/ffmpeg/development-runtime-lock.json'
    if candidate_file.parent.is_dir():candidate_file.write_text(json.dumps(candidate,indent=2)+'\n',encoding='utf-8',newline='\n')
    (output/'SHA256SUMS.txt').write_text(''.join(digest(p)+'  '+p.name+'\n' for p in archives),encoding='ascii')
    report={'runtimeVersion':lock['runtimeVersion'],'executableAndDllBytes':size,'runtimeArchiveBytes':archives[0].stat().st_size,'correspondingSourceBytes':archives[1].stat().st_size,'publication':'development_candidate'}
    (output/'size-report.json').write_text(json.dumps(report,indent=2)+'\n',encoding='utf-8');print(json.dumps(report))
