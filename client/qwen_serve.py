"""
SCP — local Qwen2.5-3B-Instruct OpenAI-compat serving shim.

Loads the HF model from your local cache (no internet hit) with 4-bit NF4
quantization via bitsandbytes, exposes a minimal /v1/chat/completions endpoint
with tool-call support, and is compatible with the qwen-mcp-bridge.js client.

Run inside scp-mvp/.venv ONLY. Never install into venv-unsloth.

Start:
    cd scp-mvp
    .venv\\Scripts\\activate
    python client/qwen_serve.py

Then in another terminal:
    LLM_BASE_URL=http://localhost:8000/v1 \\
    QWEN_MODEL=Qwen/Qwen2.5-3B-Instruct \\
    node client/qwen-mcp-bridge.js

Why 4-bit + sdpa + empty_cache:
    The naive bf16 load burned ~15GB VRAM on a 16GB card because
      (a) bf16 weights = ~6GB
      (b) torch CUDA allocator caches freed blocks aggressively
      (c) KV cache pre-allocates for growing chat history each tick
      (d) eager attention reserves a big scratch workspace
    All four stack. 4-bit NF4 + sdpa attention + empty_cache after each
    generation caps VRAM at ~3GB and keeps it stable across many ticks.
    NF4 is essentially lossless for tool-call-style reasoning workloads.
"""

import json
import time
import uuid
import re
from typing import Any

import torch
import uvicorn
from fastapi import FastAPI
from pydantic import BaseModel
from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig

MODEL_ID = "Qwen/Qwen2.5-3B-Instruct"
MAX_NEW_TOKENS = 384
TEMPERATURE = 0.2

print(f"[qwen_serve] loading {MODEL_ID} with 4-bit NF4 quantization...")

bnb_config = BitsAndBytesConfig(
    load_in_4bit=True,
    bnb_4bit_quant_type="nf4",
    bnb_4bit_use_double_quant=True,
    bnb_4bit_compute_dtype=torch.bfloat16,
)

tokenizer = AutoTokenizer.from_pretrained(MODEL_ID)
model = AutoModelForCausalLM.from_pretrained(
    MODEL_ID,
    quantization_config=bnb_config,
    device_map="auto",
    attn_implementation="sdpa",
)
model.eval()
device = next(model.parameters()).device
print(f"[qwen_serve] loaded on {device} (4-bit NF4 + sdpa attention)")
if torch.cuda.is_available():
    mem_gb = torch.cuda.memory_allocated() / 1024**3
    reserved_gb = torch.cuda.memory_reserved() / 1024**3
    print(f"[qwen_serve] VRAM after load: allocated={mem_gb:.2f} GB, reserved={reserved_gb:.2f} GB")


# ---------- OpenAI-compat request/response shapes ----------

class ChatMessage(BaseModel):
    role: str
    content: Any | None = None
    tool_calls: list | None = None
    tool_call_id: str | None = None
    name: str | None = None


class ChatRequest(BaseModel):
    model: str | None = None
    messages: list[ChatMessage]
    tools: list | None = None
    tool_choice: Any | None = None
    temperature: float = TEMPERATURE
    stream: bool = False
    max_tokens: int | None = None


# ---------- Qwen tool-call helpers ----------
# Qwen2.5-Instruct uses the Hermes-style tool-call format wrapped in
# <tool_call>{"name": "...", "arguments": {...}}</tool_call> tags.
# The chat template handles formatting tools into the system prompt.

TOOL_CALL_RE = re.compile(r"<tool_call>\s*(\{.*?\})\s*</tool_call>", re.DOTALL)


def _normalize_messages(messages: list[ChatMessage]) -> list[dict]:
    """Convert OpenAI message shape into the dict shape Qwen's chat template expects."""
    out = []
    for m in messages:
        d: dict[str, Any] = {"role": m.role}
        if m.content is not None:
            d["content"] = m.content if isinstance(m.content, str) else json.dumps(m.content)
        else:
            d["content"] = ""
        if m.tool_calls:
            d["tool_calls"] = m.tool_calls
        if m.role == "tool":
            d["name"] = m.name or "tool"
            d["content"] = m.content if isinstance(m.content, str) else json.dumps(m.content)
        out.append(d)
    return out


def _parse_tool_calls(text: str) -> tuple[str, list[dict]]:
    """Pull <tool_call>{...}</tool_call> blocks out of model output. Returns (clean_text, tool_calls)."""
    calls = []
    for match in TOOL_CALL_RE.finditer(text):
        try:
            payload = json.loads(match.group(1))
        except json.JSONDecodeError:
            continue
        name = payload.get("name") or payload.get("function") or ""
        args = payload.get("arguments") or payload.get("parameters") or {}
        if isinstance(args, dict):
            args_str = json.dumps(args)
        else:
            args_str = str(args)
        calls.append({
            "id": f"call_{uuid.uuid4().hex[:12]}",
            "type": "function",
            "function": {"name": name, "arguments": args_str},
        })
    clean = TOOL_CALL_RE.sub("", text).strip()
    return clean, calls


# ---------- FastAPI app ----------

app = FastAPI(title="SCP Qwen Shim", version="0.1.0")


@app.get("/v1/models")
def list_models():
    return {
        "object": "list",
        "data": [{"id": MODEL_ID, "object": "model", "created": 0, "owned_by": "local"}],
    }


@app.get("/health")
def health():
    info: dict[str, Any] = {"status": "ok", "model": MODEL_ID, "device": str(device)}
    if torch.cuda.is_available():
        info["vram_allocated_gb"] = round(torch.cuda.memory_allocated() / 1024**3, 2)
        info["vram_reserved_gb"] = round(torch.cuda.memory_reserved() / 1024**3, 2)
        props = torch.cuda.get_device_properties(0)
        info["vram_total_gb"] = round(props.total_memory / 1024**3, 2)
    return info


@app.post("/v1/chat/completions")
def chat_completions(req: ChatRequest):
    msgs = _normalize_messages(req.messages)
    tools = req.tools or None

    prompt_text = tokenizer.apply_chat_template(
        msgs,
        tools=tools,
        add_generation_prompt=True,
        tokenize=False,
    )

    inputs = tokenizer(prompt_text, return_tensors="pt").to(device)
    input_len = inputs["input_ids"].shape[1]

    gen_kwargs = dict(
        max_new_tokens=req.max_tokens or MAX_NEW_TOKENS,
        do_sample=req.temperature > 0,
        temperature=max(req.temperature, 0.01),
        top_p=0.9,
        pad_token_id=tokenizer.eos_token_id,
        use_cache=True,
    )

    try:
        with torch.no_grad():
            out_ids = model.generate(**inputs, **gen_kwargs)
        new_tokens = out_ids[0, input_len:]
        text = tokenizer.decode(new_tokens, skip_special_tokens=True).strip()
    finally:
        # Release KV cache + scratch buffers immediately so VRAM doesn't creep
        # across ticks. This is the single most important line for long-running stability.
        if torch.cuda.is_available():
            torch.cuda.empty_cache()

    clean_text, tool_calls = _parse_tool_calls(text)

    message: dict[str, Any] = {"role": "assistant"}
    if tool_calls:
        message["content"] = clean_text or None
        message["tool_calls"] = tool_calls
        finish_reason = "tool_calls"
    else:
        message["content"] = clean_text
        finish_reason = "stop"

    return {
        "id": f"chatcmpl-{uuid.uuid4().hex[:16]}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": MODEL_ID,
        "choices": [{
            "index": 0,
            "message": message,
            "finish_reason": finish_reason,
        }],
        "usage": {
            "prompt_tokens": int(input_len),
            "completion_tokens": int(new_tokens.shape[0]),
            "total_tokens": int(input_len + new_tokens.shape[0]),
        },
    }


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8000, log_level="info")
