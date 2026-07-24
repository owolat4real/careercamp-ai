# Deploying careercamp-ai + Ollama to a RunPod GPU Pod

Moves the internal AI models (cs-haiku, cs-sonnet, cs-opus, cs-embed —
~6.7GB combined) off "only works when your own machine is on" and onto a
persistent GPU pod that Render (cs_fixed) can reach 24/7.

**Note:** everything below is native (no Docker) and uses direct-TCP SSH
+ a Cloudflare Tunnel — not the docker-compose / rsync-over-proxy /
RunPod-HTTP-port approach this doc originally described. Those didn't
work in practice (see the "why not" notes inline) and this file was
updated to match what was actually run.

## 1. Provision the pod

- runpod.io → **Pods** (not Serverless) → Deploy
- GPU: an **RTX A4000 (16GB VRAM)** comfortably fits all 4 models
  resident simultaneously (~8GB used, ~8GB free) — no need for a bigger
  card. Cheap tiers (A5000, A4500, RTX 2000 Ada) frequently show
  "Instance not available" at click time; availability fluctuates in
  real time, so just retry a few GPU types if your first pick is out of
  stock.
- Template: **Runpod Pytorch** (any CUDA-enabled base image works — Docker
  itself is *not* available inside a RunPod pod, since the pod is
  already a container; docker-compose approaches won't work here)
- Container disk: **30GB+** (set this correctly at pod **creation** time
  — resizing a running pod's disk via `runpodctl pod update` destabilizes
  it, sometimes permanently; recreate the pod instead of resizing)
- Ports at creation: `8888/http,22/tcp` is enough. Do **not** add more
  ports later via `runpodctl pod update --ports` — like the disk resize,
  this triggers a full container reset that wipes everything outside the
  pod's actual persistent volume (which, unless you explicitly configure
  a network volume at creation, is *not* what `/workspace` is — it's
  ordinary container disk and is just as ephemeral as the rest of the
  container). Use a Cloudflare Tunnel instead (step 5) to expose new
  ports without ever touching the pod's port config again.
- Connect tab shows two SSH options: the `ssh.runpod.io` proxy is
  PTY-only (rejects non-interactive commands and SCP/SFTP outright) —
  use **"SSH over exposed TCP"** instead (`ssh root@<ip> -p <port>`),
  which supports both.

## 2. Install Ollama + Node.js natively on the pod

```bash
ssh root@<pod-ip> -p <ssh-port> -i ~/.ssh/id_ed25519

apt-get update
apt-get install -y zstd pciutils lshw curl   # zstd: Ollama's installer needs it to
                                              # extract its own release archive.
                                              # pciutils/lshw: needed for Ollama to
                                              # detect the GPU — without them it
                                              # silently falls back to CPU-only.
curl -fsSL https://ollama.com/install.sh | sh   # should print "NVIDIA GPU installed"

curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs
```

## 3. Clone the repo and transfer the custom models

```bash
mkdir -p /workspace/careercamp-ai /workspace/ollama-models
git clone https://github.com/owolat4real/careercamp-ai.git /workspace/careercamp-ai
```

These 4 models are custom fine-tunes with no public registry — there's
no `ollama pull cs-sonnet`. From your **local machine**, stage just the
4 models' manifests + deduplicated blobs (much smaller than your whole
`~/.ollama/models`), then `scp` them over directly:

```bash
scp -r ~/cs-models-stage/* root@<pod-ip>:/workspace/ollama-models/ -P <ssh-port>
```

(`scripts/transfer-models-to-pod.sh`'s rsync-over-proxy approach doesn't
work — the proxy connection type used there is PTY-only. Plain `scp`
over the direct-TCP SSH connection is simpler and does work.)

## 4. Start Ollama with all 4 models resident

```bash
OLLAMA_MODELS=/workspace/ollama-models OLLAMA_MAX_LOADED_MODELS=4 \
  OLLAMA_NUM_PARALLEL=1 OLLAMA_KEEP_ALIVE=-1 OLLAMA_FLASH_ATTENTION=1 \
  nohup ollama serve > /tmp/ollama.log 2>&1 & disown
```

`OLLAMA_NUM_PARALLEL=1` matters — a higher value reserves KV-cache
memory per *concurrent request slot* per model, which can force the
larger models to partially spill onto CPU even when there's nominally
enough total VRAM.

If a specific model (check via `ollama ps`) shows `<100% CPU/GPU` split
instead of `100% GPU`, check whether its Modelfile hardcodes a low
`num_gpu` value (`ollama show <model> --parameters`) — this pins the
number of GPU-resident layers independent of how much VRAM is actually
free, and is a model-config issue, not a capacity one. Fix by rebuilding
it with a higher (or `99`, meaning "all") value:

```bash
ollama show <model> --modelfile > /tmp/model.modelfile
sed -i 's/PARAMETER num_gpu .*/PARAMETER num_gpu 99/' /tmp/model.modelfile
ollama create <model> -f /tmp/model.modelfile
```

Load the largest model first (while the most VRAM is free), then the
rest, and verify with `ollama ps` + `nvidia-smi`.

## 5. Set up `.env` and start the gateway

Copy the same values from `cs_fixed/.env`:

```
CAREERCAMP_PORT=3002
OLLAMA_URL=http://127.0.0.1:11434
OLLAMA_MODELS=/workspace/ollama-models
CAREERCAMP_API_KEY=<same value as in cs_fixed/.env>
CS_TRANSFORMER_API_KEY=<same value as in cs_fixed/.env>
CAREERCAMP_SECRET_KEY=<same value as in cs_fixed/.env>
GROQ_API_KEY=<same value>
OPENROUTER_API_KEY=<same value>
ALLOWED_ORIGINS=https://careerstudiomax.com,https://www.careerstudiomax.com
```

```bash
cd /workspace/careercamp-ai
npm install
nohup node server.js > /tmp/gateway.log 2>&1 & disown
```

## 6. Expose the gateway with a Cloudflare Tunnel

Don't use RunPod's own port-exposure UI/API for this (see the warning in
step 1 — it resets the container). Instead:

```bash
curl -fsSL -o /usr/local/bin/cloudflared \
  https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
chmod +x /usr/local/bin/cloudflared
nohup cloudflared tunnel --url http://localhost:3002 > /tmp/cloudflared.log 2>&1 & disown
grep trycloudflare /tmp/cloudflared.log   # your public URL
```

This free "quick tunnel" URL is stable as long as the `cloudflared`
process itself doesn't restart (individual network reconnects don't
change it) — but it **does** change if the process (or the whole pod)
restarts, which means Render's env vars need updating again at that
point. For a permanent, stable URL tied to your own domain, set up a
[named Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/)
instead, authenticated to your Cloudflare account.

`/workspace/start-all.sh` (written during setup) restarts Ollama + the
gateway + a fresh tunnel with one command if the pod ever reboots —
just note the tunnel URL will be different afterward.

## 7. Point Render at the pod

In Render → `career-studio` service → Environment:

```
CAMP_API_URL=<your-tunnel-url>/v1
CAREERCAMP_BASE_URL=<your-tunnel-url>/v1
```

(There is no separate `CAREERCAMP_URL` variable in the codebase — just
these two. Previously neither was set at all, which silently defaulted
to `http://localhost:3002/v1` — meaningless on Render's own servers, and
the actual root cause of internal models always falling through to
Groq/OpenRouter/Anthropic in production before this setup.)

Save → Render auto-redeploys (or trigger one manually via the API if the
GitHub webhook is slow) → internal models should now actually respond.

## 8. Verify

```bash
curl <your-tunnel-url>/health
curl -X POST <your-tunnel-url>/v1/chat/completions \
  -H "Authorization: Bearer <CAREERCAMP_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"model":"cs-sonnet","messages":[{"role":"user","content":"hi"}]}'
```

Check the response's `_engine` field — it should say `"ollama"`, not
`"groq"`/`"openrouter"`. Then tail `/tmp/gateway.log` on the pod while
using the site for real to confirm production traffic is actually
landing (look for real `User-Agent`s like `OpenAI/JS` — that's Render's
client library, not your own test curls).
