"""The render helper: draws Kitbash! pictures for one server worker, in a process of its own.

build_images starts it (one per worker) and sends one job per line on stdin; each reply is
one JSON line on stdout. A drawing that hangs here is killed by the worker after its time
limit and costs that one picture, instead of freezing the whole server (build_images, "The
render helper"). It draws with build_images' own in-process functions, so there is a single
copy of the drawing code.

    {"op": "ping"}                                        -> {"ok": true, "loaded": bool}
    {"op": "build", "items", "ammo", "ubgl_ammo"}         -> {"ok": true, "data": base64, "skipped": [...]}
    {"op": "character", "view", "customization", "equipment"} -> {"ok": true, "data": base64}
    any failure                                           -> {"ok": false, "error": kind, "message": text}
"""

import base64
import json
import logging
import os
import sys

# Draw here, never in yet another helper
os.environ["KITBASH_RENDER_ISOLATED"] = "0"


def _die_with_parent() -> None:
    """On Linux, have the kernel kill us the moment our worker goes, even while a drawing is
    stuck in native code and never reads the stdin that would tell us (prctl
    PR_SET_PDEATHSIG). Elsewhere stdin closing is enough."""
    if not sys.platform.startswith("linux"):
        return
    try:
        import ctypes
        import signal

        ctypes.CDLL("libc.so.6", use_errno=True).prctl(1, int(signal.SIGKILL))  # 1 = PR_SET_PDEATHSIG
    except (OSError, AttributeError):
        return
    if os.getppid() == 1:  # the worker went before the prctl took
        os._exit(0)


_die_with_parent()

# stdout carries the replies alone: anything else that prints (an import, Kitbash!) goes to
# stderr, the journal, so it can never break a reply line
_replies = sys.stdout
sys.stdout = sys.stderr

import build_images  # noqa: E402

_logger = logging.getLogger("render_helper")


def _reply(obj: dict) -> None:
    _replies.write(json.dumps(obj, separators=(",", ":")) + "\n")
    _replies.flush()


def _handle(job: dict) -> dict:
    op = job.get("op")
    if op == "ping":
        return {"ok": True, "loaded": build_images._get() is not None}
    if op == "build":
        if build_images._get() is None:
            return {"ok": False, "error": "unloaded", "message": "kitbash is not loaded"}
        data, skipped = build_images._render_here(job["items"], job.get("ammo"), job.get("ubgl_ammo"))
        return {"ok": True, "data": base64.b64encode(data).decode("ascii"), "skipped": skipped}
    if op == "character":
        data = build_images._render_character_here(job["view"], job["customization"], job["equipment"])
        return {"ok": True, "data": base64.b64encode(data).decode("ascii")}
    return {"ok": False, "error": "invalid", "message": f"unknown op {op!r}"}


def main() -> None:
    logging.basicConfig(level=logging.WARNING, format="render helper: %(levelname)s %(message)s")
    for line in sys.stdin:
        try:
            job = json.loads(line)
            reply = _handle(job)
        except build_images.UnsupportedWeapon as exc:
            reply = {"ok": False, "error": "unsupported", "message": str(exc)}
        except build_images.Unrenderable as exc:
            reply = {"ok": False, "error": "unrenderable", "message": str(exc)}
        except (ValueError, KeyError, TypeError) as exc:
            reply = {"ok": False, "error": "invalid", "message": str(exc)}
        except Exception as exc:  # one odd job never ends the helper
            _logger.exception("job failed")
            reply = {"ok": False, "error": "failed", "message": str(exc)}
        _reply(reply)


if __name__ == "__main__":
    main()
