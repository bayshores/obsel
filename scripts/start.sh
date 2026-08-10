#!/bin/bash
#
# Every setup step in docs/setup.md, run in an order that document leaves to the
# reader, so that reaching the board takes no typing.
#
# The ordering is the reason this exists rather than a list of commands in the
# README. Two steps have to happen after DataHub is answering and not before:
# registering obsel's tag, which cannot be created at run time, and starting the
# app, whose first read of the board is a real read. A reader working down eight
# numbered steps has no way to tell that the wait in step 1 is load-bearing.
#
# What it does not do: install Docker, install Node, or sign in to an agent
# CLI. Those need a human, so each is detected and named with the one thing to
# do next. Only
# `uv` is installed here, because it is needed twice, its own installer is the one
# docs/setup.md already documents, and it is the single tool a judge is otherwise
# most likely to lack.
#
# Every step is safe to repeat. A second run skips DataHub if it is already
# answering, keeps an existing .env.local, keeps an existing virtual environment,
# and does not start a second server.
#
# Bash 3.2, because that is what macOS ships and what a double-clicked
# `Start obsel.command` beside it gets. No associative arrays, no `${var^^}`, no `local -n`.

set -u

TOTAL_STEPS=9
GMS_URL="http://localhost:8080"
APP_URL="http://localhost:3000"
DATAHUB_PIN="acryl-datahub==1.6.0.15"

# The DataHub stack a judge gets, pinned rather than left to resolve.
#
# Measured on 2026-07-28: with no version asked for, the 1.6.0.15 CLI planned
# `composefile_git_ref='v1.5.0.6' docker_tag='v1.5.0.6'`, which is the version
# every number in docs/verification.md was measured against. So this pin is what
# already happens, written down.
#
# It is written down because the unpinned form does not read that mapping from
# the CLI: it fetches a version mapping over the network at run time, so the same
# command gives judges different stacks on different days, and obsel would be
# running against a DataHub nobody has checked it on. That is the same failure
# shape as MCP_SERVER_DATAHUB_VERSION in .env.example, where resolving to
# @latest silently disabled every write while still reporting success.
#
# Two traps, both found by running it on 2026-07-28 rather than by reading:
#
# `--version v1.5.0.6` alone is REFUSED. The CLI keeps a version map with only a
# handful of keys (default, head, quickstart, stable, and a few old releases),
# there is no v1.5.0 key in it, and an unlisted value exits with "requires
# confirmation in a non-interactive environment" -- which in a double-clicked
# launcher is every time. `--accept-version-default` is what allows it, and the
# flag is misleadingly named: it does not fall back to the default, it accepts
# the exact unlisted version given. Measured, it planned
# `composefile_git_ref='v1.5.0.6' docker_tag='v1.5.0.6'` and fetched that tag's
# compose file, so both halves are genuinely pinned.
#
# `--version stable` is NOT this version. That key maps to v1.6.0, which nothing
# here has been measured against, so asking for "stable" would be asking for the
# one thing this pin exists to avoid.
#
# To move it: run the launcher with the new value, then `pnpm test:live`, then
# update this line and the version named in docs/setup.md together.
DATAHUB_STACK_VERSION="v1.5.0.6"

# How long to wait for DataHub to answer after its own start command returns, and
# for the app to compile. Both are ceilings on a wait that normally ends early.
DATAHUB_WAIT_S=180
APP_WAIT_S=120

DEV_LOG="obsel-dev.log"
DEV_PID=""

# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------

say() { printf '%s\n' "$*"; }
ok() { printf '  ok   %s\n' "$*"; }
info() { printf '       %s\n' "$*"; }

step() {
  printf '\nStep %s of %s: %s\n' "$1" "$TOTAL_STEPS" "$2"
}

# How to run this again, named the way the reader started it.
retry_phrase() {
  if [ "$(uname -s)" = "Darwin" ]; then
    printf '%s' 'double-click "scripts/Start obsel.command" again'
  else
    printf '%s' 'run "bash scripts/start.sh" again'
  fi
}

# What happened, then the one thing to do about it. Never a bare trace: the
# reader of this window is a judge who did not write any of this.
fail() {
  printf '\n'
  printf 'obsel could not continue.\n'
  printf '\n'
  printf '  %s\n' "$1"
  printf '\n'
  printf '  What to do: %s\n' "$2"
  if [ $# -ge 3 ]; then
    printf '\n'
    printf '  %s\n' "$3"
  fi
  printf '\n'
  exit 1
}

# ---------------------------------------------------------------------------
# Step 0: make the machine's own tools findable
# ---------------------------------------------------------------------------
#
# A double-clicked .command is not a login shell, so it never reads .zprofile or
# .zshrc. Homebrew, uv and nvm all install themselves by writing to those files,
# which means that without this every check below reports "not installed" on a
# machine that has the tool. That is the worst answer available: it sends the
# reader to install something they already have.

add_to_path() {
  if [ -d "$1" ]; then
    case ":$PATH:" in
      *":$1:"*) ;;
      *) PATH="$1:$PATH" ;;
    esac
  fi
}

repair_path() {
  add_to_path "/opt/homebrew/bin"
  add_to_path "/usr/local/bin"
  add_to_path "$HOME/.local/bin"
  add_to_path "$HOME/.cargo/bin"
  export PATH
}

# nvm keeps its versions outside every directory above, and installs itself only
# into an interactive shell's startup file. Sourcing its script is the supported
# way to reach it; `set +u` around the source because nvm.sh reads variables it
# has not set, and this script runs under `set -u`.
load_nvm_if_needed() {
  if node_major_ok; then return 0; fi
  if [ ! -s "$HOME/.nvm/nvm.sh" ]; then return 0; fi
  info "Node was not on the path, and nvm is installed. Loading it."
  set +u
  # shellcheck disable=SC1091
  NVM_DIR="$HOME/.nvm" . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1
  nvm use 24 >/dev/null 2>&1 || nvm use default >/dev/null 2>&1
  set -u
}

node_major_ok() {
  local version
  version="$(node --version 2>/dev/null)" || return 1
  case "$version" in
    v24.*) return 0 ;;
    *) return 1 ;;
  esac
}

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

have() { command -v "$1" >/dev/null 2>&1; }

# One HTTP GET, no body, short ceiling. Used for both "is it up yet" polls.
answers() {
  curl -fsS --max-time 5 "$1" >/dev/null 2>&1
}

# pnpm is a hard requirement of the app and an optional one of the machine:
# Node 24 bundles corepack, which fetches the pnpm version package.json pins.
PNPM_VIA_COREPACK="no"
run_pnpm() {
  if [ "$PNPM_VIA_COREPACK" = "yes" ]; then
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm "$@"
  else
    pnpm "$@"
  fi
}

# Wait for a URL, printing a dot a second so a long wait does not look like a
# hang. Returns non-zero if the ceiling is reached.
wait_for_url() {
  local url="$1" ceiling="$2" waited=0
  while [ "$waited" -lt "$ceiling" ]; do
    if answers "$url"; then
      [ "$waited" -gt 0 ] && printf '\n'
      return 0
    fi
    printf '.'
    sleep 2
    waited=$((waited + 2))
  done
  printf '\n'
  return 1
}

open_browser() {
  if have open; then
    open "$1" >/dev/null 2>&1 && return 0
  fi
  if have xdg-open; then
    xdg-open "$1" >/dev/null 2>&1 && return 0
  fi
  return 1
}

stop_dev_server() {
  if [ -n "$DEV_PID" ]; then
    kill "$DEV_PID" >/dev/null 2>&1
  fi
}

# ---------------------------------------------------------------------------
# Start
# ---------------------------------------------------------------------------

repair_path

# The repository is this script's parent directory. Resolved from the script's
# own location rather than the working directory, because Finder starts a
# double-clicked file from the user's home directory, not from the repository.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT" || {
  fail "This script could not enter the obsel folder it lives in ($REPO_ROOT)." \
    "check that the folder was fully unzipped, then $(retry_phrase)."
}

say "obsel setup"
say ""
say "This gets everything running and then opens the board in your browser."
say "You do not need to type anything. Leave this window open while it works."
say ""
say "The first run takes a while, because DataHub downloads several large"
say "images. Later runs skip whatever is already done."
say ""
say "Folder: $REPO_ROOT"

if ! have curl; then
  fail "This script needs the curl command to check whether DataHub and obsel have started, and curl is not installed." \
    "install curl, then $(retry_phrase)."
fi

# ---------------------------------------------------------------------------
step 1 "Docker"
# ---------------------------------------------------------------------------
#
# `docker info` rather than `command -v docker`: the question is whether the
# daemon will answer, and an installed Docker Desktop that has not been opened
# yet fails exactly the way a missing one does from the app's point of view.

if ! have docker; then
  fail "Docker is not installed. obsel runs DataHub, a set of databases and services, in Docker containers on your own machine." \
    "install Docker Desktop, open it once, then $(retry_phrase)." \
    "Download: https://www.docker.com/products/docker-desktop/"
fi

if ! docker info >/dev/null 2>&1; then
  fail "Docker is installed but not running, so nothing can start the DataHub containers." \
    "open Docker Desktop and wait until its whale icon stops animating, then $(retry_phrase)." \
    "If it is already open, it may still be starting up. Give it a minute."
fi
ok "Docker is running."

# ---------------------------------------------------------------------------
step 2 "Node and pnpm"
# ---------------------------------------------------------------------------

load_nvm_if_needed

if ! have node; then
  fail "Node is not installed. obsel's dashboard is a Node application." \
    "install Node 24 (the LTS download), then $(retry_phrase)." \
    "Download: https://nodejs.org/"
fi

if ! node_major_ok; then
  fail "obsel needs Node 24, and this machine has $(node --version 2>/dev/null). Next.js 16 does not run on older versions." \
    "install Node 24, then $(retry_phrase)." \
    "Download: https://nodejs.org/"
fi
ok "Node $(node --version) is installed."

if have pnpm; then
  ok "pnpm $(pnpm --version 2>/dev/null) is installed."
elif have corepack; then
  PNPM_VIA_COREPACK="yes"
  info "pnpm is not installed. Using corepack, which comes with Node, to fetch"
  info "the version this project pins."
  if ! COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm --version >/dev/null 2>&1; then
    fail "pnpm is not installed, and corepack could not download it. This usually means no internet connection." \
      "check your connection, or install pnpm yourself with 'npm install -g pnpm', then $(retry_phrase)."
  fi
  ok "pnpm $(COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm --version 2>/dev/null) is ready through corepack."
else
  fail "pnpm is not installed, and corepack, which normally comes with Node and can fetch it, is missing too." \
    "install pnpm with 'npm install -g pnpm', then $(retry_phrase)."
fi

# ---------------------------------------------------------------------------
step 3 "Python 3"
# ---------------------------------------------------------------------------
#
# On a Mac without the command line tools, `python3 --version` does not answer:
# it opens Apple's installer dialog and returns non-zero. The message says so,
# because the reader will be looking at that dialog while reading this.

if ! python3 --version >/dev/null 2>&1; then
  fail "Python 3 is not available. The demo agents are Python programs." \
    "if macOS just offered to install its command line tools, accept it, wait for it to finish, then $(retry_phrase)." \
    "Otherwise install Python 3 from https://www.python.org/downloads/ and try again."
fi
ok "$(python3 --version 2>&1) is installed."

# ---------------------------------------------------------------------------
step 4 "uv"
# ---------------------------------------------------------------------------
#
# The one tool this script installs. obsel writes its tag through DataHub's own
# MCP server, which is started with uvx, and step 5 uses uvx again to run the
# DataHub command line tool without a separate global install.

if have uvx; then
  ok "uv $(uv --version 2>/dev/null | awk '{print $2}') is installed."
else
  info "uv is not installed. Installing it now with the installer from its"
  info "makers at https://astral.sh/uv. It goes in $HOME/.local/bin and can be"
  info "removed by deleting that folder."
  if ! curl -LsSf https://astral.sh/uv/install.sh | sh; then
    fail "The uv installer did not finish. obsel needs uv to write its tag into DataHub." \
      "check your internet connection and $(retry_phrase), or install uv yourself with 'brew install uv'."
  fi
  add_to_path "$HOME/.local/bin"
  export PATH
  if ! have uvx; then
    fail "uv reported that it installed, but the uvx command still cannot be found." \
      "close this window, open a new terminal, run 'brew install uv', then $(retry_phrase)."
  fi
  ok "uv is installed."
fi

# ---------------------------------------------------------------------------
step 5 "DataHub"
# ---------------------------------------------------------------------------
#
# The DataHub command line tool is a separate global install of acryl-datahub,
# and it is the one prerequisite no document gave an install command for. uvx
# runs it from a pinned version without installing anything permanently, so a
# machine that has it keeps using its own and a machine that does not needs
# nothing extra. The pin matches agents/requirements.txt.

if answers "$GMS_URL/config"; then
  ok "DataHub is already running at $GMS_URL."
else
  info "Starting DataHub. The first run downloads several large images and can"
  info "take five to ten minutes. DataHub's own progress appears below."
  say ""
  if have datahub; then
    datahub docker quickstart --version "$DATAHUB_STACK_VERSION" --accept-version-default
    quickstart_status=$?
  else
    uvx --from "$DATAHUB_PIN" datahub docker quickstart --version "$DATAHUB_STACK_VERSION" --accept-version-default
    quickstart_status=$?
  fi
  say ""
  if [ "$quickstart_status" -ne 0 ]; then
    fail "DataHub did not start. Its own output is above this message." \
      "check that Docker Desktop has enough memory (Settings, Resources, at least 8 GB), then $(retry_phrase)." \
      "If the output above mentions a port already in use, something else on this machine is using DataHub's ports."
  fi

  # The start command has returned, which is not the same as the API answering.
  info "Waiting for DataHub's API to answer."
  if ! wait_for_url "$GMS_URL/config" "$DATAHUB_WAIT_S"; then
    fail "DataHub's containers started, but its API at $GMS_URL did not answer within $DATAHUB_WAIT_S seconds." \
      "wait a minute for it to finish starting, then $(retry_phrase)." \
      "You can check on the containers with 'docker ps'."
  fi
  ok "DataHub is running at $GMS_URL."
fi

# A reply from /config is not a health check. That reply is served from the GMS
# process itself, so it keeps arriving when the search container behind it has
# stopped, which is the failure recorded in docs/environment-findings.md and in
# src/server/runner/preflight.ts. It is enough to know the next step can be
# attempted; step 7 registering its tag and reading it back is the real proof,
# and the checklist on the board keeps checking after this script has finished.

# ---------------------------------------------------------------------------
step 6 "obsel's settings and packages"
# ---------------------------------------------------------------------------

if [ -f .env.local ]; then
  ok "Settings file .env.local is already there, and was left alone."
else
  if ! cp .env.example .env.local; then
    fail "Could not create the settings file .env.local from .env.example." \
      "check that you have permission to write in $REPO_ROOT, then $(retry_phrase)."
  fi
  ok "Created the settings file .env.local from .env.example."
fi

# The API token. Every route that changes anything requires it, and with the
# line empty those routes answer 503 to everyone -- a closed deployment, which
# is the safe default and a broken demo. So an empty OBSEL_API_TOKEN= line gets
# a generated value here, whether the file was just created or has sat for
# weeks; a line somebody filled in themselves is never touched, per the
# safe-to-repeat rule at the top of this script.
#
# The value itself is deliberately not printed: this window is what a demo
# recording captures. The file is named instead, and the board's token field
# takes the value from there.
generate_token() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 24
  else
    # No openssl: bytes from urandom, printed as safe characters. LC_ALL=C so
    # tr treats them as bytes rather than as text in the operator's locale.
    LC_ALL=C tr -dc 'a-f0-9' < /dev/urandom | head -c 48
  fi
}

if grep -q '^OBSEL_API_TOKEN=[[:space:]]*$' .env.local; then
  TOKEN_VALUE="$(generate_token)"
  if [ -z "$TOKEN_VALUE" ]; then
    fail "Could not generate an API token: neither openssl nor /dev/urandom produced one." \
      "put any long random value on the OBSEL_API_TOKEN= line in .env.local, then $(retry_phrase)."
  fi
  # awk into a temp file and move it back: sed -i takes different arguments on
  # macOS and Linux, and this script runs on both under bash 3.2.
  if ! awk -v token="$TOKEN_VALUE" '
    sub(/^OBSEL_API_TOKEN=[[:space:]]*$/, "OBSEL_API_TOKEN=" token) { }
    { print }
  ' .env.local > .env.local.tmp; then
    rm -f .env.local.tmp
    fail "Could not write the generated API token into .env.local." \
      "check that you have permission to write in $REPO_ROOT, then $(retry_phrase)."
  fi
  mv .env.local.tmp .env.local
  ok "Generated an API token into .env.local. The board's token field takes this value."
else
  ok "An API token is already set in .env.local, and was left alone."
fi

info "Installing the app's packages. This takes a minute on the first run."
if ! run_pnpm install; then
  fail "Installing the app's Node packages failed. The output above says why." \
    "check your internet connection, then $(retry_phrase)."
fi
ok "The app's packages are installed."

# The demo agents' Python packages are separate from the Node ones, and this is
# the step people skip when following the documentation by hand.
if [ -x "agents/.venv/bin/python" ]; then
  ok "The demo agents already have their own Python environment."
else
  info "Creating the demo agents' own Python environment in agents/.venv."
  if ! python3 -m venv agents/.venv; then
    fail "Could not create the Python environment in agents/.venv." \
      "check that Python 3 is fully installed by running 'python3 -m venv --help', then $(retry_phrase)."
  fi
fi

# Run every time rather than only after creating it: pip is quick when the
# packages are already there, and it repairs an environment left half-built by
# an interrupted first run.
info "Installing the demo agents' Python packages."
if ! agents/.venv/bin/python -m pip install --quiet -r agents/requirements.txt; then
  fail "Installing the demo agents' Python packages failed. The output above says why." \
    "check your internet connection, then $(retry_phrase)."
fi
ok "The demo agents have their Python packages."

# ---------------------------------------------------------------------------
step 7 "obsel's tag in DataHub"
# ---------------------------------------------------------------------------
#
# obsel cannot create a tag while running, so without this it would find work
# that had gone out of date and have nowhere to record it, which looks exactly
# like nothing being wrong. The command confirms both writes landed and fails
# loudly if either did not, so its exit code is the answer.

info "Registering obsel's tag and demo pipeline in DataHub."
if ! agents/.venv/bin/python -m agents.run setup; then
  fail "Registering obsel's tag in DataHub failed. The output above says which part did not land." \
    "$(retry_phrase). If it fails again, DataHub may still be starting up: wait a minute first." \
    "Do not skip this. Without the tag, obsel detects out-of-date work and cannot record it."
fi
ok "obsel's tag is registered in DataHub."

# ---------------------------------------------------------------------------
step 8 "The agent CLI"
# ---------------------------------------------------------------------------
#
# Checked but never blocking. Signing in opens a browser and needs the person,
# so this reports and moves on; the board's checklist carries the same item and
# keeps checking it while they deal with it.
#
# The same rule as `agents/runner_select.py` and `preflight.ts`: OBSEL_RUNNER
# picks one, and with nothing set the first installed wins, Codex first. Only
# the selected one is reported on, because only it will be invoked.

runner_status() {
  # $1 is the runner name. Prints nothing; the exit code is the answer.
  case "$1" in
    codex) codex login status >/dev/null 2>&1 ;;
    claude) claude auth status >/dev/null 2>&1 ;;
  esac
}

# Three outcomes, and they are kept apart deliberately: a name obsel does not
# know is a different problem from nothing being installed, and reporting both
# would tell an operator with both CLIs installed to go and install one.
case "${OBSEL_RUNNER:-}" in
  codex | claude) chosen="$OBSEL_RUNNER" ;;
  "")
    if have codex; then
      chosen=codex
    elif have claude; then
      chosen=claude
    else
      chosen=none
    fi
    ;;
  *) chosen=unknown ;;
esac

# Two forms of the name, because the two products capitalize differently:
# "the Codex CLI" mid-sentence is "The Codex CLI" at the start of one, while
# "Claude Code" is the same in both. Capitalizing the first letter at the point
# of use would print "The claude Code".
if [ "$chosen" = codex ]; then
  chosen_label="the Codex CLI"
  chosen_label_start="The Codex CLI"
  chosen_sign_in="codex login"
elif [ "$chosen" = claude ]; then
  chosen_label="Claude Code"
  chosen_label_start="Claude Code"
  chosen_sign_in="claude auth login"
fi

if [ "$chosen" = unknown ]; then
  info "OBSEL_RUNNER is set to '$OBSEL_RUNNER', which is not a runner obsel knows."
  info "Valid values are codex and claude. Unset it to use whichever is installed."
elif [ "$chosen" = none ]; then
  info "No agent CLI is installed. Each demo agent is a real session of one, and"
  info "there is no way to run them with an API key instead, so the demo buttons"
  info "will not run without one. Install either Claude Code or the Codex CLI."
  info "Everything else on the board works. The checklist shows this too."
elif runner_status "$chosen"; then
  ok "$chosen_label_start is signed in."
elif have "$chosen"; then
  info "$chosen_label_start is installed but not signed in. Each demo agent is a real"
  info "$chosen_label session, so the demo buttons will not run until it is."
  info "Sign in with:  $chosen_sign_in"
  info "The checklist on the board shows this too, and ticks when it is done."
else
  # Only reachable through an explicit OBSEL_RUNNER, since detection above
  # picks an installed one. Naming what was asked for rather than falling
  # back, so the message matches the board and the worker.
  info "OBSEL_RUNNER asks for $chosen_label, which is not installed, so the demo"
  info "buttons will not run. Install it, or unset OBSEL_RUNNER to use whichever"
  info "agent CLI this machine has."
fi

# ---------------------------------------------------------------------------
step 9 "Start obsel"
# ---------------------------------------------------------------------------

if answers "$APP_URL"; then
  ok "obsel is already running at $APP_URL."
  say ""
  say "Opening it in your browser. The window that started it is the one to"
  say "close when you are finished."
  open_browser "$APP_URL" || say "Open this address yourself: $APP_URL"
  exit 0
fi

info "Starting obsel. The first page takes up to a minute to build."
info "Its output is being written to $DEV_LOG in this folder."
# Backgrounded directly rather than through run_pnpm, so that the recorded pid is
# the server's own. Backgrounding the function instead records the pid of a
# subshell, and killing that leaves the server running with nothing holding it.
if [ "$PNPM_VIA_COREPACK" = "yes" ]; then
  COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm dev >"$DEV_LOG" 2>&1 &
else
  pnpm dev >"$DEV_LOG" 2>&1 &
fi
DEV_PID=$!

# From here on, closing this window or pressing Ctrl-C stops the server rather
# than leaving it running with nothing pointing at it.
trap 'stop_dev_server' INT TERM EXIT

if ! wait_for_url "$APP_URL" "$APP_WAIT_S"; then
  say ""
  say "The last lines of $DEV_LOG:"
  tail -n 40 "$DEV_LOG"
  fail "obsel did not answer at $APP_URL within $APP_WAIT_S seconds. Its output is above." \
    "read the lines above for the reason, then $(retry_phrase)." \
    "If they mention a port already in use, something else on this machine is using port 3000."
fi

say ""
say "-----------------------------------------------------------------------"
say "obsel is running at $APP_URL"
say ""
say "Your browser should be opening it now. The board starts with a short"
say "checklist of anything still missing, and a tour button in its header."
say ""
say "Leave this window open. Closing it stops obsel."
say "-----------------------------------------------------------------------"
say ""

open_browser "$APP_URL" || say "Open this address in your browser: $APP_URL"

# The window's lifetime is the server's. Output keeps arriving in the log file
# rather than here, so the message above stays the last thing on screen.
wait "$DEV_PID"
