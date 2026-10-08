# -*- coding: utf-8 -*-
"""
AI 检测引擎入口：stdio JSON-RPC 服务
协议：每行一个 JSON。
  请求  {"id":1,"method":"detect","params":{"path":"...","imageId":123,"device":"cpu"}}
  响应  {"id":1,"result":{...DetectResult...}}  或 {"id":1,"error":"..."}
  事件  {"event":"log","level":"info","msg":"..."}
      {"event":"ready","capabilities":{...}}
方法：ping / detect / warmup / shutdown
GPU/CPU：自动检测 onnxruntime CUDAExecutionProvider，可被 device 参数覆盖。
"""
import sys
import json
import os
import time
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from engine import DetectEngine  # noqa: E402


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def log(msg, level="info"):
    emit({"event": "log", "level": level, "msg": msg})


def main():
    device = None
    args = sys.argv[1:]
    if "--device" in args:
        device = args[args.index("--device") + 1]
    engine = DetectEngine(device=device, log=log)
    emit({
        "event": "ready",
        "capabilities": engine.capabilities(),
        "device": engine.device,
        "pid": os.getpid(),
    })
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            continue
        rid = req.get("id")
        method = req.get("method")
        params = req.get("params") or {}
        try:
            if method == "ping":
                emit({"id": rid, "result": {"pong": True, "capabilities": engine.capabilities()}})
            elif method == "detect":
                t0 = time.time()
                result = engine.detect(params.get("path"), params.get("imageId"))
                result["elapsedMs"] = int((time.time() - t0) * 1000)
                emit({"id": rid, "result": result})
            elif method == "warmup":
                engine.warmup()
                emit({"id": rid, "result": {"ok": True}})
            elif method == "shutdown":
                emit({"id": rid, "result": {"ok": True}})
                break
            else:
                emit({"id": rid, "error": "unknown method: %s" % method})
        except Exception as e:  # noqa: BLE001
            log(traceback.format_exc(), "error")
            emit({"id": rid, "error": str(e)})
    engine.close()


if __name__ == "__main__":
    main()
