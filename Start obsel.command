#!/bin/bash
#
# What a judge double-clicks on macOS. Finder runs a .command file in Terminal,
# starting it from the user's home directory rather than from this folder, so the
# first job is to get into the folder this file is in. Everything else is in
# scripts/start.sh, which is also the file to run by hand on Linux.
#
# `exec bash` rather than running the script directly: a zip extracted by some
# tools drops the executable bit, and this way the launcher still works when that
# has happened.

cd "$(dirname "$0")" || exit 1
exec bash scripts/start.sh
