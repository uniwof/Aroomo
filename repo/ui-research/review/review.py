#!/usr/bin/env python3
"""辩论式设计评审：把设计计划 + 四张截图（或 HTML 摘要）发给 Groq / Gemini / NVIDIA，要求反对、给证据。
用法：python3 review.py round1   （结果写 review/round1-<model>.md）
密钥由 Hark 身份网关在请求时注入（api.groq.com / generativelanguage.googleapis.com / integrate.api.nvidia.com），脚本里不放密钥。"""
import base64, json, os, sys, urllib.request, pathlib
HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent
rnd = sys.argv[1] if len(sys.argv) > 1 else "round1"
brief = (HERE / "brief.md").read_text()
extra = (HERE / f"{rnd}-extra.md").read_text() if (HERE / f"{rnd}-extra.md").exists() else ""
shots = [p for p in sorted((ROOT / "shots").glob("*.png")) if any(k in p.name for k in ("01-chat-1440", "01-chat-390", "02-member-1440", "03-roster-1440", "04-settings-1440", "01-chat-dark-390"))]

SYSTEM = ("你是资深产品设计评审，评的是给一位有眼疾、主要用 iPhone 的用户做的「AI 团队群聊」界面。"
          "规则：不要附和，不要先夸。至少提 6 条你反对或认为会失败的点，每条写：问题 → 证据（指到具体区域/数值）→ 你的改法。"
          "最后给一个总判断：如果只能改 3 处，改哪 3 处。用简体中文。")

def post(url, body, headers):
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={"content-type": "application/json", **headers})
    with urllib.request.urlopen(req, timeout=180) as r:
        return json.loads(r.read())

def b64(p): return base64.b64encode(p.read_bytes()).decode()

def groq():
    model = os.environ.get("GROQ_MODEL", "meta-llama/llama-4-scout-17b-16e-instruct")
    content = [{"type": "text", "text": brief + "\n\n" + extra}]
    for p in shots[:5]:
        content.append({"type": "image_url", "image_url": {"url": "data:image/png;base64," + b64(p)}})
    r = post("https://api.groq.com/openai/v1/chat/completions",
             {"model": model, "messages": [{"role": "system", "content": SYSTEM}, {"role": "user", "content": content}], "temperature": 0.6, "max_tokens": 2500}, {})
    return model, r["choices"][0]["message"]["content"]

def groq_text(model):
    r = post("https://api.groq.com/openai/v1/chat/completions",
             {"model": model, "messages": [{"role": "system", "content": SYSTEM}, {"role": "user", "content": brief + "\n\n" + extra}], "temperature": 0.6, "max_tokens": 3000}, {})
    return model, r["choices"][0]["message"]["content"]

def gemini():
    model = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")
    parts = [{"text": SYSTEM + "\n\n" + brief + "\n\n" + extra}] + [{"inline_data": {"mime_type": "image/png", "data": b64(p)}} for p in shots]
    r = post(f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent", {"contents": [{"parts": parts}]}, {})
    return model, "".join(p.get("text", "") for p in r["candidates"][0]["content"]["parts"])

def nvidia():
    model = os.environ.get("NV_MODEL", "meta/llama-3.3-70b-instruct")
    r = post("https://integrate.api.nvidia.com/v1/chat/completions",
             {"model": model, "messages": [{"role": "system", "content": SYSTEM}, {"role": "user", "content": brief + "\n\n" + extra}], "temperature": 0.6, "max_tokens": 3000}, {})
    return model, r["choices"][0]["message"]["content"]

which = sys.argv[2:] or ["gemini", "groq", "nvidia"]
for w in which:
    try:
        if w == "groq": m, t = groq()
        elif w == "groqtext": m, t = groq_text(os.environ.get("GROQ_TEXT_MODEL", "openai/gpt-oss-120b"))
        elif w == "gemini": m, t = gemini()
        else: m, t = nvidia()
        out = HERE / f"{rnd}-{w}.md"
        out.write_text(f"# {rnd} · {m}\n\n{t}\n")
        print("OK", w, m, out, len(t))
    except Exception as e:
        print("FAIL", w, repr(e)[:400])
