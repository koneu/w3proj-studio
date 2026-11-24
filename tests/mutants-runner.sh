#!/bin/sh
# Cargo target runner for mutation testing (TESTING.md "Coverage"): each test binary gets at most 3 GB of address
# space and 90 s, so a mutant that loops while allocating dies (and counts as caught) instead of filling the machine.
# One such mutant (`i += 1` made `i *= 1` in paths.rs) grew a test binary to 35 GB on 2026-11-24.
ulimit -v 3000000
exec timeout -s KILL 90 "$@"
