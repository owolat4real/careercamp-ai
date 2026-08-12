#!/usr/bin/env python3
"""
═══════════════════════════════════════════════════════════════════════
CAREER STUDIO — Real, isolated Python data-analysis execution, RunPod
Serverless entrypoint
═══════════════════════════════════════════════════════════════════════

Same real job-queue shape as _svd_src/, _sadtalker_src/, _xtts_src/:
JSON in, JSON out, any generated media (here: real matplotlib chart
PNGs) uploaded to S3 and returned as real URLs, not raw bytes.

Input:
  job['input']['code']         — real Python source (pandas/numpy/
                                  matplotlib all genuinely available);
                                  must assign its answer to a variable
                                  named `result` (JSON-serializable),
                                  same convention as the JS compute
                                  sandbox for a consistent real contract.
  job['input']['files']        — optional {filename: base64Content} of
                                  real input data (e.g. a CSV) made
                                  available in the execution's own
                                  jailed working directory.

See cs_fixed/services/workspaceAgentPython.js for the Node-side client
that submits to /run and polls /status against this handler's output
shape.
"""

import logging
import os
import time
import uuid

import boto3
import runpod

import _engine

logger = logging.getLogger("pyexec-runpod")

_s3 = None


def _s3_client():
    global _s3
    if _s3 is not None:
        return _s3
    key = os.environ.get("AWS_ACCESS_KEY_ID")
    if not key:
        return None
    _s3 = boto3.client(
        "s3",
        region_name=os.environ.get("AWS_REGION", "us-east-1"),
        aws_access_key_id=key,
        aws_secret_access_key=os.environ.get("AWS_SECRET_ACCESS_KEY"),
    )
    return _s3


def _upload_chart(png_bytes: bytes, filename: str) -> str:
    bucket = os.environ.get("AWS_S3_BUCKET", "career-studio-uploads")
    key = f"media/python-exec-charts/{uuid.uuid4().hex}-{filename}"
    s3 = _s3_client()
    if not s3:
        raise RuntimeError("AWS_ACCESS_KEY_ID not set — cannot upload a generated chart")
    s3.put_object(Bucket=bucket, Key=key, Body=png_bytes, ContentType="image/png")
    cf = os.environ.get("AWS_CLOUDFRONT_URL")
    if cf:
        return f"{cf.rstrip('/')}/{key}"
    return f"https://{bucket}.s3.amazonaws.com/{key}"


def handler(job):
    t0 = time.time()
    job_input = job.get("input") or {}
    code = job_input.get("code")
    input_files = job_input.get("files") or {}

    if not code or not isinstance(code, str):
        return {"error": "code is required and must be a real Python source string"}

    try:
        import base64

        outcome = _engine.run_python_code(code, input_files)
        elapsed = round(time.time() - t0, 1)

        if not outcome.get("success"):
            return {"error": outcome.get("error", "Execution failed for an unknown real reason"), "inferenceSeconds": elapsed}

        chart_urls = []
        for chart in outcome.get("charts", []):
            try:
                png_bytes = base64.b64decode(chart["base64"])
                chart_urls.append(_upload_chart(png_bytes, chart["filename"]))
            except Exception as e:
                logger.warning(f"[PyExec] chart upload failed for {chart.get('filename')}: {e}")

        logger.info(f"[PyExec] Executed in {elapsed}s, {len(chart_urls)} real chart(s) uploaded")
        return {
            "result": outcome.get("result"),
            "stdout": outcome.get("stdout", ""),
            "chartUrls": chart_urls,
            "engine": "self-hosted-python-exec-runpod-serverless",
            "inferenceSeconds": elapsed,
        }
    except Exception as e:
        logger.warning(f"[PyExec] Handler failed: {e}", exc_info=True)
        return {"error": str(e)}


runpod.serverless.start({"handler": handler})
