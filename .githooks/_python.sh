#!/usr/bin/env bash
# Shared interpreter probe for the gate hooks.
#
# `"$PY" -c ''` only proves the interpreter starts — it says nothing about
# PyYAML, which every gate subprocess imports. A Python that launches fine but
# lacks the dependency reports its failure as 43 × "No module named 'yaml'"
# inside the test run, so a wrong interpreter looks like a broken repository.
# Probe the dependency the gate actually needs.
#
# Sourced by pre-commit / pre-push / post-commit after `cd "$ROOT"`; expects
# `set -euo pipefail` in the caller and leaves the chosen interpreter in $PY.
# shellcheck shell=bash

# An exported PYTHON is a deliberate operator choice: honour it or fail loudly.
# Falling back to another interpreter behind their back is how a run silently
# tests the wrong environment.
if [ -n "${PYTHON:-}" ]; then
  if ! "$PYTHON" -c 'import yaml' >/dev/null 2>&1; then
    printf 'gate: PYTHON=%s cannot `import yaml`; install PyYAML or unset PYTHON\n' \
      "$PYTHON" >&2
    exit 1
  fi
  PY="$PYTHON"
else
  PY=""
  for candidate in python3 python; do
    if command -v "$candidate" >/dev/null 2>&1 \
      && "$candidate" -c 'import yaml' >/dev/null 2>&1; then
      PY="$candidate"
      break
    fi
  done
  if [ -z "$PY" ]; then
    printf 'gate: no python interpreter with PyYAML found; set PYTHON=/path/to/python\n' >&2
    exit 1
  fi
fi
export PY
