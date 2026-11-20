#!/usr/bin/env bash
# Entry point: sudo ./setup.sh
cd "$(dirname "$0")" && exec bash scripts/wizard.sh "$@"
