"""Real persistent-worker regression with repeated requests and shape changes.

No installation or subjective audio claims. Run using the intended runtime's
Python; all generated files stay beneath the supplied new output directory.
"""
import argparse
import json
import os
from pathlib import Path
import queue
import socket
import struct
import subprocess
import sys
import threading
import time


def minimax_output_limit(root, duration):
    """Exact sample ceiling from this installed upstream decoder's geometry.

    Window stitching has fractional-second padding that accumulates with
    length. The maximum AR duration is not an exact waveform duration.
    """
    from diffusers.modular_pipelines.minimax_music3 import before_denoise, decoders, encoders
    config=json.loads((root/'condition_encoder/config.json').read_text())
    frame_rate=config['input_sampling_rate']/config['input_hop_length']
    frames=min(int(duration*frame_rate),encoders._MAX_AUDIO_FRAMES)
    starts=([0] if frames<=before_denoise._CHUNK_FRAMES else
            list(range(0,frames-before_denoise._CHUNK_HOP,before_denoise._CHUNK_HOP)))
    latents=sum(max(1,int(min(before_denoise._CHUNK_FRAMES,frames-start)
        *config['output_sampling_rate']/config['input_sampling_rate']
        *config['input_hop_length']/config['output_hop_length'])) for start in starts)
    latents-=(len(starts)-1)*(decoders._CROP_LEFT_LATENT+decoders._CROP_RIGHT_LATENT)
    return {'maxArFrames':frames,'maxSamples':latents*config['output_hop_length'],
        'sampleRate':config['output_sampling_rate'],'decoderWindows':len(starts)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", required=True, choices=["stable-audio-3-medium", "ace-step-v15-xl-turbo", "minimax-music-3"])
    parser.add_argument("--model-root", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--optimization", default="standard", choices=["standard", "compile", "torchao-int8", "disk-offload", "fp8-storage", "rocm-fast-startup"])
    parser.add_argument("--durations", nargs="+", type=float, default=[30, 30, 60, 30])
    parser.add_argument("--timeout", type=float, default=600)
    parser.add_argument("--requests", type=Path, help="Declared workflow/params/expectedDuration test cases")
    args = parser.parse_args()
    root = args.output_dir.resolve()
    root.mkdir(parents=True, exist_ok=False)
    script = Path(__file__).with_name("generate_music.py" if args.model.startswith("ace") else "stable_audio3_generate.py")
    command = [sys.executable, "-u", "-X", "faulthandler", str(script), "--worker", "--model-id", str(args.model_root if args.model.startswith("ace") else args.model),
               "--cache-root" if args.model.startswith("ace") else "--model-root", str(args.model_root), "--optimization", args.optimization]
    environment = dict(os.environ, HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1")
    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=environment,
        creationflags=getattr(subprocess,"CREATE_NO_WINDOW",0), text=True, encoding="utf-8", errors="replace")
    events = queue.Queue()
    def read():
        with (root/"worker.log").open("w", encoding="utf-8") as log:
            for line in process.stdout:
                log.write(line); log.flush()
                try:
                    message = json.loads(line)
                    if isinstance(message,dict): events.put(message)
                except ValueError: pass
        events.put({"event":"exited", "exitCode":process.wait()})
    reader = threading.Thread(target=read, daemon=True)
    reader.start()
    report = {"model":args.model, "optimization":args.optimization, "runs":[], "status":"running", "audioQuality":"not_asserted"}
    def save():
        (root/"report.json").write_text(json.dumps(report,indent=2),encoding="utf-8")
    def wait_for(predicate):
        import psutil
        deadline = time.monotonic()+args.timeout
        low_since = None
        while time.monotonic() < deadline:
            if psutil.virtual_memory().available < 2*1024**3:
                low_since = low_since or time.monotonic()
                if time.monotonic()-low_since > 2: raise RuntimeError("Host RAM safety floor reached")
            else: low_since = None
            try: message = events.get(timeout=.5)
            except queue.Empty: continue
            if message.get("event") == "exited": raise RuntimeError("Worker exited: "+str(message))
            if predicate(message): return message
        raise TimeoutError("Worker did not complete within its deadline")
    def receive(connection, count):
        data=b""
        while len(data)<count:
            part=connection.recv(count-len(data))
            if not part: raise RuntimeError("Incomplete worker response")
            data+=part
        return data
    try:
        ready=wait_for(lambda message:message.get("event")=="ready")
        report["ready"]=ready
        workloads = json.loads(args.requests.read_text(encoding="utf-8")) if args.requests else [
            {"params":{"duration":duration},"expectedDuration":duration} for duration in args.durations]
        for index,workload in enumerate(workloads):
            duration = float(workload["expectedDuration"])
            request_id=f"qualification-{index}"
            output=root/f"run-{index}.wav"
            params={"prompt":"A mellow acoustic song with a clear solo vocal and gentle guitar.",
                "lyrics":"[verse]\nMorning light upon the sea\nA quiet song comes back to me", "duration":duration,"steps":30 if args.model=="minimax-music-3" else 8,"seed":123,
                "modelVariant":"original","generationOptimization":args.optimization}
            params.update(workload.get("params", {}))
            if params["modelVariant"] != "original" or params["generationOptimization"] != args.optimization:
                raise ValueError("Workload conflicts with the declared model/optimization")
            workflow = workload.get("workflow", "text-to-music" if args.model.startswith("ace") else "lyrics-style" if args.model=="minimax-music-3" else "text-to-audio")
            request={"command":"generate","requestId":request_id,"modelId":args.model,
                "workflow":workflow,
                "params":json.dumps(params),"output":str(output),"protocolVersion":ready["protocolVersion"],"scriptVersion":ready["scriptVersion"]}
            started=time.monotonic()
            encoded=json.dumps(request).encode()
            with socket.create_connection(("127.0.0.1",ready["port"]),timeout=20) as connection:
                connection.sendall(struct.pack(">I",len(encoded))+encoded)
                size=struct.unpack(">I",receive(connection,4))[0]
                if size>8*1024**2: raise RuntimeError("Oversized worker response")
                response=json.loads(receive(connection,size))
                if not response.get("accepted"): raise RuntimeError(str(response))
                terminal=wait_for(lambda message:message.get("requestId")==request_id and message.get("state") in {"done","error"})
            if terminal.get("state")!="done": raise RuntimeError(str(terminal.get("error",terminal)))
            if args.optimization == "rocm-fast-startup":
                policy=terminal.get("generationDetails",{}).get("execution",{}).get("startupPolicy",{})
                if policy.get("recipe") != "ace-gfx1151-miopen-fast-v1" or policy.get("precisionChange") is not False:
                    raise RuntimeError("Worker did not prove the requested AMD startup recipe")
            import soundfile as sf
            import numpy as np
            duration_limit=minimax_output_limit(args.model_root,duration) if args.model=='minimax-music-3' else None
            with sf.SoundFile(output) as audio:
                actual_duration=len(audio)/audio.samplerate
                output_frames=len(audio)
                duration_valid=(actual_duration>=.25 and len(audio)<=duration_limit['maxSamples']+2
                                and audio.samplerate==duration_limit['sampleRate'] if duration_limit
                                else abs(actual_duration-duration)<=2/audio.samplerate)
                if audio.channels!=2 or not duration_valid:
                    raise RuntimeError("Output shape or duration changed")
                for block in audio.blocks(blocksize=65536,always_2d=True):
                    if not np.isfinite(block).all(): raise RuntimeError("Nonfinite output")
            report["runs"].append({"duration":duration,"outputDurationSeconds":actual_duration,
                "outputFrames":output_frames,"durationLimit":duration_limit,
                "durationScope":"normal EOS within requested maximum; not a forced-capacity test" if args.model=="minimax-music-3" else "requested duration",
                "workflow":workflow,"params":params,
                "seconds":time.monotonic()-started,"terminal":terminal,"status":"pass"})
            save()
            print("request",index,"pass",flush=True)
        report["status"]="pass"
        with socket.create_connection(("127.0.0.1",ready["port"]),timeout=20) as connection:
            encoded=json.dumps({"command":"shutdown","requestId":"shutdown","modelId":args.model}).encode()
            connection.sendall(struct.pack(">I",len(encoded))+encoded)
            size=struct.unpack(">I",receive(connection,4))[0]
            response=json.loads(receive(connection,size))
            if not response.get("accepted"): raise RuntimeError("Worker refused idle shutdown")
        process.wait(timeout=30)
        if process.returncode: raise RuntimeError("Worker shutdown failed")
        report["gracefulShutdown"]="pass"
        return 0
    except Exception as exc:
        report.update(status="fail",error=f"{type(exc).__name__}: {exc}")
        print(report["error"],flush=True)
        return 1
    finally:
        if process.poll() is None:
            import psutil
            parent=psutil.Process(process.pid)
            children=parent.children(recursive=True)
            # All are descendants of this harness-owned worker, including compiler helpers.
            for child in reversed(children):
                try: child.kill()
                except psutil.NoSuchProcess: pass
            process.terminate()
            process.wait(timeout=20)
        reader.join(timeout=10)
        report["workerRetired"]=process.poll() is not None
        save()


if __name__ == "__main__":
    raise SystemExit(main())
