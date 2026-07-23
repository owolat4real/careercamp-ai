# Deploying careercamp-ai + Ollama to a RunPod GPU Pod

Moves the internal AI models (cs-haiku, cs-sonnet, cs-opus, cs-embed —
~8.7GB combined) off "only works when your own machine is on" and onto a
persistent GPU pod that Render (cs_fixed) can reach 24/7.

## 1. Provision the pod

- runpod.io → **Pods** (not Serverless) → Deploy
- GPU: **RTX A5000, 24GB VRAM** — comfortably fits all 4 models (~8.7GB)
  resident simultaneously with room to spare. Community Cloud pricing
  (~$0.16/hr, ~$115/mo) unless you specifically want Secure Cloud's
  reliability guarantees (~$0.27/hr, ~$195/mo).
- Template: **RunPod PyTorch** (or any CUDA-enabled base image with Docker)
- Enable **SSH access** on the pod (Connect tab → toggle SSH) — needed for
  the model transfer step below.
- Disk: 30GB+ (8.7GB of models + Docker images + headroom)

## 2. Get the pod running with Docker Compose

SSH into the pod (command shown on its Connect tab), then:

```bash
git clone https://github.com/owolat4real/careercamp-ai.git
cd careercamp-ai
cp .env.example .env   # fill in the values from step 3 below
docker-compose up -d careercamp-gateway ollama
```

This starts **only** the gateway (port 3002) + Ollama (port 11434) — not
the full stack (no nginx, no careerstudio-app; cs_fixed stays on Render).

## 3. Environment variables for the pod's `.env`

Copy these from your local `cs_fixed/.env` (same values, so the auth keys
match what cs_fixed will send):

```
CAREERCAMP_PORT=3002
OLLAMA_URL=http://ollama:11434
CAREERCAMP_API_KEY=<same value as in cs_fixed/.env>
CS_TRANSFORMER_API_KEY=<same value as in cs_fixed/.env>
CAREERCAMP_SECRET_KEY=<same value as in cs_fixed/.env>
INTERNAL_SECRET=<same value as in cs_fixed/.env>
GROQ_API_KEY=<same value — external fallback if internal models are ever down>
OPENROUTER_API_KEY=<same value>
ALLOWED_ORIGINS=https://careerstudiomax.com,https://www.careerstudiomax.com
```

**Important:** `apiKeyAuth` (server.js) fails OPEN if none of
`CAREERCAMP_API_KEY`/`CS_TRANSFORMER_API_KEY`/`CAREERCAMP_SECRET_KEY` are
set — double-check these are actually populated on the pod before
exposing it publicly, or every route is unauthenticated.

## 4. Transfer your custom models onto the pod

These models are custom fine-tunes with no public registry — there's no
`ollama pull cs-sonnet`. From your **local machine** (not the pod):

```bash
cd careercamp-ai/scripts
./transfer-models-to-pod.sh <pod-ip> <ssh-port> [path-to-ssh-key]
```

(pod IP/port/key come from the same Connect tab as step 1). This rsyncs
your local `~/.ollama` into the pod's running `ollama` container and
restarts it. Verify all 4 models show up in the script's final `ollama
list` output.

## 5. Expose the gateway publicly

RunPod → your pod → **Connect** → HTTP Service → expose port **3002**
only. Do **not** expose port 11434 (raw Ollama, no auth of its own) —
only the gateway, which now has `apiKeyAuth` on every `/v1/*` route.

Copy the resulting public URL (something like
`https://<pod-id>-3002.proxy.runpod.net`).

## 6. Point Render at the pod

In Render → cs_fixed service → Environment, change:

```
CAMP_API_URL=https://<pod-id>-3002.proxy.runpod.net/v1
CAREERCAMP_BASE_URL=https://<pod-id>-3002.proxy.runpod.net/v1
CAREERCAMP_URL=https://<pod-id>-3002.proxy.runpod.net
```

(previously all three pointed at `http://localhost:3002`, which on
Render's own servers resolves to nothing — that's the root cause of the
internal model always failing in production up to now.)

Save → Render auto-redeploys → internal models should now actually
respond instead of always falling through to Groq/OpenRouter/Anthropic.

## 7. Verify

```bash
curl https://<pod-id>-3002.proxy.runpod.net/health
curl -X POST https://<pod-id>-3002.proxy.runpod.net/v1/chat/completions \
  -H "Authorization: Bearer <CAREERCAMP_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"model":"cs-sonnet","messages":[{"role":"user","content":"hi"}]}'
```

Then check `careerstudiomax.com`'s Brain AI widget — server logs (or the
SSE `engine` field in the response) should show `camp:careerlm-*` or
similar succeeding instead of immediately falling through to
`openrouter`/`groq-retry`.
