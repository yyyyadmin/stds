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
import io
import time
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from engine import DetectEngine  # noqa: E402


def _force_utf8_stdio():
    """强制 stdio 走 UTF-8。
    PyInstaller 冻结的 exe 在 Windows 上默认按本地代码页(cp936/GBK)读写 sys.stdin/stdout，
    而 Node 侧按 UTF-8 收发 JSON。含中文的照片路径会在 stdin 解码阶段被解成乱码，
    np.fromfile 打开乱码路径必然失败(cannot decode)，导致每张图检测失败；返回的中文
    reason 文本也会乱码。这里显式把三个流重设为 UTF-8（兼容不支持 reconfigure 的情况）。
    """
    for name in ("stdin", "stdout", "stderr"):
        stream = getattr(sys, name, None)
        if stream is None:
            continue
        try:
            stream.reconfigure(encoding="utf-8")
        except Exception:  # noqa: BLE001
            try:
                setattr(sys, name, io.TextIOWrapper(stream.buffer, encoding="utf-8"))
            except Exception:  # noqa: BLE001
                pass


def emit(obj):
    # ensure_ascii=True：输出纯 ASCII(\uXXXX)，使中文 reason 不受冻结 exe 的 GBK stdout 影响，
    # Node 侧 JSON.parse 会把 \uXXXX 完整还原成正确中文。
    sys.stdout.write(json.dumps(obj, ensure_ascii=True) + "\n")
    sys.stdout.flush()


def log(msg, level="info"):
    emit({"event": "log", "level": level, "msg": msg})


def main():
    _force_utf8_stdio()
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
    if "--selfcheck" in sys.argv:
        from engine.selfcheck import main as _selfcheck_main
        sys.exit(_selfcheck_main())
    main()
