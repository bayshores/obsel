#!/bin/bash
#
# What a judge double-clicks on macOS. Finder starts a .command file from the
# user's home directory rather than from the folder it lives in, so this has to
# find the repository itself. Everything else is in start.sh beside it, which is
# also the file to run by hand on Linux.
#
# `exec bash` rather than running start.sh directly: a zip extracted by some
# tools drops the executable bit, and this way the launcher still works when that
# has happened.

cd "$(dirname "$0")/.." || exit 1
exec bash scripts/start.sh
