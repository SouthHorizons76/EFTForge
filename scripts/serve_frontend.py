"""Local dev static server for frontend/ (launch.bat), python -m http.server plus the one
rewrite the site needs: a loaded Atlas profile's address, /atlas/players/<mode>/<account ID>,
is the players page, whose script reads the player from the path. Keep in step with the prod
nginx rule and backend/desktop.py."""

import http.server
import os
import re
import sys
from functools import partial

FRONTEND_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "frontend")
PLAYER_PATH = re.compile(r"^/atlas/players/[a-z]+/[0-9]{1,12}/?(?:[?#].*)?$")


class Handler(http.server.SimpleHTTPRequestHandler):
    def translate_path(self, path):
        if PLAYER_PATH.match(path):
            path = "/atlas/players/index.html"
        return super().translate_path(path)


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5500
    handler = partial(Handler, directory=FRONTEND_DIR)
    with http.server.ThreadingHTTPServer(("", port), handler) as server:
        print(f"Serving frontend on port {port}")
        server.serve_forever()


if __name__ == "__main__":
    main()
