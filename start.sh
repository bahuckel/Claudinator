#!/usr/bin/env sh
# Start Claudinator and open it in the default browser.
set -e
cd "$(dirname "$0")"
URL="http://localhost:${PORT:-8752}"
(command -v xdg-open >/dev/null 2>&1 && xdg-open "$URL") \n  || (command -v open >/dev/null 2>&1 && open "$URL") \n  || echo "Open $URL in your browser."
exec node server.js
