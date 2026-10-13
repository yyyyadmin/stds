"""
姿态门可分性分析（纯离线，读试点产出的 _pilot_pose.json，不碰库）

配对：同目录 + phash 汉明<=9 = "AI 现在会判为同一组"的那些对
标签：任一端 rej -> NOT_DUP（你说不是重复）；任一端 ok/add -> DUP（你说是重复）；冲突丢弃
特征：同秩人脸的 |Δyaw| |Δpitch| |Δroll|、脸中心位移/脸高、人体中心位移/体高、
      |ΔeyeBlink| |ΔjawOpen|、人数差
输出：每个特征的两群分布 + 一致性比例（AUC，0.5=完全没用，1.0=完美分开）+ 建议门限

用法：& "C:\\Users\\windows\\AppData\\Local\\Programs\\Python\\Python311\\python.exe" scripts\\dup-pilot-analyze.py
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
POSE = os.path.join(REPO, "app", "scripts", "_pilot_pose.json")
HAM_MAX = 9


def ham(a, b):
    if not a or not b:
        return 99
    n = 0
    for x, y in zip(a, b):
        v = int(x, 16) ^ int(y, 16)
        while v:
            n += v & 1
            v >>= 1
    return n


def center(box):
    return (box[0] + box[2] / 2.0, box[1] + box[3] / 2.0)


def pair_feats(a, b):
    """两只图的特征差。缺姿态的脸不参与角度统计（缺数据不能被当成"没差异"）。"""
    fa, fb = a["faces"], b["faces"]
    n = min(len(fa), len(fb), 3)
    ang = {"dyaw": [], "dpitch": [], "droll": [], "dblink": [], "dmouth": []}
    shift = []
    for k in range(n):
        x, y = fa[k], fb[k]
        if x.get("hasMp") and y.get("hasMp"):
            ang["dyaw"].append(abs(x["yaw"] - y["yaw"]))
            ang["dpitch"].append(abs(x["pitch"] - y["pitch"]))
            ang["droll"].append(abs(x["roll"] - y["roll"]))
            ang["dblink"].append(abs(x["blink"] - y["blink"]))
            ang["dmouth"].append(abs(x["mouth"] - y["mouth"]))
        hh = (x["box"][3] + y["box"][3]) / 2.0
        if hh > 1:
            c1, c2 = center(x["box"]), center(y["box"])
            shift.append(((c1[0] - c2[0]) ** 2 + (c1[1] - c2[1]) ** 2) ** 0.5 / hh)
    ba = [z for z in a["bodies"] if z.get("filtered")]
    bb = [z for z in b["bodies"] if z.get("filtered")]
    bshift, bsize = [], []
    m = min(len(ba), len(bb), 3)
    for k in range(m):
        x, y = ba[k], bb[k]
        hh = (x["box"][3] + y["box"][3]) / 2.0
        if hh > 1:
            c1, c2 = center(x["box"]), center(y["box"])
            bshift.append(((c1[0] - c2[0]) ** 2 + (c1[1] - c2[1]) ** 2) ** 0.5 / hh)
            bsize.append(abs(x["box"][3] - y["box"][3]) / hh)
    out = {}
    for key, lst in list(ang.items()) + [("fshift", shift), ("bshift", bshift), ("bsize", bsize)]:
        out[key] = max(lst) if lst else None
    out["dface"] = abs(len(fa) - len(fb))
    out["dbody"] = abs(len(ba) - len(bb))
    out["ham"] = ham(a.get("phash"), b.get("phash"))
    return out


def stats(vals):
    v = sorted(x for x in vals if x is not None)
    if not v:
        return "无数据"
    return "n=%d min=%.2f 中位=%.2f p75=%.2f max=%.2f" % (len(v), v[0], v[len(v) // 2], v[int(len(v) * 0.75)] if len(v) > 1 else v[-1], v[-1])


def auc(dup, notdup):
    """一致性比例：NOT_DUP 的特征值大于 DUP 的比例。0.5 = 该特征毫无区分力。"""
    d = [x for x in dup if x is not None]
    n = [x for x in notdup if x is not None]
    if not d or not n:
        return None, 0
    win = tie = tot = 0
    for a in n:
        for b in d:
            tot += 1
            if a > b:
                win += 1
            elif a == b:
                tie += 1
    return (win + 0.5 * tie) / float(tot), tot


KEYS = [
    ("dyaw", "头部偏航差(度)"),
    ("droll", "头部翻滚差(度)"),
    ("dpitch", "头部俯仰差(度)"),
    ("fshift", "脸位移动差/脸高"),
    ("bshift", "人体位移动差/体高"),
    ("bsize", "人体大小变化差"),
    ("dblink", "眼睛闭合度差"),
    ("dmouth", "张嘴度差"),
    ("dface", "检出人脸数差"),
    ("dbody", "检出人体数差"),
]


def main():
    recs = [r for r in json.load(open(POSE, encoding="utf-8")) if r.get("phash")]
    by_id = {r["id"]: r for r in recs}
    print("参与 %d 张（有 phash）· 标签分布 %s" % (len(recs), json.dumps({k: sum(1 for r in recs if r["label"] == k) for k in ("rej", "add", "ok", "ctx")})))

    pairs = []
    for i, a in enumerate(recs):
        for b in recs[i + 1:]:
            if a["dir"] != b["dir"]:
                continue
            h = ham(a["phash"], b["phash"])
            if h > HAM_MAX:
                continue
            lab = {a["label"], b["label"]}
            if lab & {"rej"} and lab & {"ok", "add"}:
                tag = "amb"
            elif "rej" in lab:
                tag = "NOT_DUP"
            elif lab & {"ok", "add"}:
                tag = "DUP"
            else:
                tag = "ctx"
            pairs.append((tag, a, b, pair_feats(a, b)))
    cnt = {}
    for t, _, _, _ in pairs:
        cnt[t] = cnt.get(t, 0) + 1
    print("汉明≤%d 的同目录配对 %d 个：%s" % (HAM_MAX, len(pairs), json.dumps(cnt)))

    dups = [f for t, _, _, f in pairs if t == "DUP"]
    nots = [f for t, _, _, f in pairs if t == "NOT_DUP"]
    print("\n=== 表1：你说'是重复'(%d 对) vs 你说'不是重复'(%d 对) 的特征分布 ===" % (len(dups), len(nots)))
    print("特征                 DUP 群分布                                  NOT_DUP 群分布                              AUC")
    rows = []
    for key, cn in KEYS:
        s1 = stats([f[key] for f in dups])
        s2 = stats([f[key] for f in nots])
        a, tot = auc([f[key] for f in dups], [f[key] for f in nots])
        rows.append((key, cn, s1, s2, a, tot))
        print("%-18s %-38s %-38s %s" % (cn, s1, s2, ("%.2f" % a) if a is not None else "n/a"))

    print("\n=== 表2：单特征当门的收益（DUP 被保住=不误放，NOT_DUP 被放开=救回你否定的）===")
    print("门限（超过则判'不是重复'）")
    for key, cn, _, _, _, _ in rows:
        best = None
        for step in range(1, 25):
            T = step * (5.0 if key in ("dyaw", "droll", "dpitch") else (2.0 if key in ("bshift", "fshift", "bsize") else 0.1 if key in ("dblink", "dmouth") else 1.0))
            saved = sum(1 for f in nots if f[key] is not None and f[key] > T)
            lost = sum(1 for f in dups if f[key] is not None and f[key] > T)
            score = saved - lost
            if best is None or score > best[0]:
                best = (score, T, saved, lost)
        if best and best[0] > 0:
            print("  %-18s 最优门限 %-6.2f → 救回 NOT_DUP %d/%d，误放 DUP %d/%d（净 %+d）" % (cn, best[1], best[2], len(nots), best[3], len(dups), best[0]))
        else:
            print("  %-18s 单靠这个特征没有正收益（净 ≤0）" % cn)

    # 组合门：任一超阈值
    print("\n=== 表3：组合门（任意一条超标就不算重复）===")
    combos = [("dyaw>12 或 droll>10 或 bshift>0.35", lambda f: (f["dyaw"] or 0) > 12 or (f["droll"] or 0) > 10 or (f["bshift"] or 0) > 0.35),
              ("dyaw>20 或 bshift>0.5", lambda f: (f["dyaw"] or 0) > 20 or (f["bshift"] or 0) > 0.5),
              ("dblink>0.25 或 dmouth>0.25", lambda f: (f["dblink"] or 0) > 0.25 or (f["dmouth"] or 0) > 0.25),
              ("上面三条全并", lambda f: (f["dyaw"] or 0) > 12 or (f["droll"] or 0) > 10 or (f["bshift"] or 0) > 0.35 or (f["dblink"] or 0) > 0.25 or (f["dmouth"] or 0) > 0.25)]
    for name, fn in combos:
        saved = sum(1 for f in nots if fn(f))
        lost = sum(1 for f in dups if fn(f))
        print("  %-34s 救回 NOT_DUP %d/%d · 误放 DUP %d/%d · 净 %+d" % (name, saved, len(nots), lost, len(dups), saved - lost))

    print("\n=== 表4：NOT_DUP 逐对明细（你否定过的那批，看哪条特征把它们和伙伴分开）===")
    print("  %-15s %-15s ham dyaw droll dpitch fshift bshift dblink dmouth" % ("图A", "图B"))
    for t, a, b, f in [p for p in pairs if p[0] == "NOT_DUP"][:24]:
        def g(v, w=5):
            return ("%-*s" % (w, "%.1f" % v if v is not None else "-"))
        print("  %-15s %-15s %3d %s %s %s %s %s %s %s" % (a["filename"][:14], b["filename"][:14], f["ham"], g(f["dyaw"], 5), g(f["droll"], 5), g(f["dpitch"], 6), g(f["fshift"], 6), g(f["bshift"], 6), g(f["dblink"], 6), g(f["dmouth"], 6)))
    print("\n=== 表5：DUP 逐对明细（你认可/补打的，这些必须留在组里）===")
    for t, a, b, f in [p for p in pairs if p[0] == "DUP"][:20]:
        def g2(v, w=5):
            return ("%-*s" % (w, "%.1f" % v if v is not None else "-"))
        print("  %-15s %-15s %3d %s %s %s %s %s %s %s" % (a["filename"][:14], b["filename"][:14], f["ham"], g2(f["dyaw"], 5), g2(f["droll"], 5), g2(f["dpitch"], 6), g2(f["fshift"], 6), g2(f["bshift"], 6), g2(f["dblink"], 6), g2(f["dmouth"], 6)))
    void = by_id
    print("\n（参与配对的图 %d 张）" % len(void))


if __name__ == "__main__":
    main()
