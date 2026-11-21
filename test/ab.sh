#!/bin/bash
# A/B timing: runs two entries' main.ts alternately (so drift in the machine hits both alike),
# pinned to one CPU, and prints each one's trimmed mean of user+sys CPU ms. Each run must exit 0.
# Usage (inside WSL): bash test/ab.sh <entry A> <entry B> <kit dir> [rounds]
NODE=$(ls -d ~/n22/node-v22.23.5-linux-x64/bin/node)
A=$1
B=$2
KIT=$3
ROUNDS=${4:-15}
OUT=$(mktemp -d)
export MAKEFUN_INPUT_DIR=$KIT/practice/input MAKEFUN_OUTPUT_DIR=$OUT
ta=()
tb=()
one() {
  (cd "$1" && /usr/bin/time -o "$OUT/t" -f "%U %S %x" taskset -c 0 "$NODE" main.ts > /dev/null 2>&1)
  read -r u s x < "$OUT/t"
  if [ "$x" != "0" ]; then echo "FAILED in $1" >&2; exit 1; fi
  awk -v u="$u" -v s="$s" 'BEGIN {printf "%.0f", (u + s) * 1000}'
}
for i in $(seq 1 "$ROUNDS"); do
  ta+=("$(one "$A")")
  tb+=("$(one "$B")")
done
trim() { printf '%s\n' "$@" | sort -n | awk '{a[NR]=$1} END {s=0;c=0;for(i=3;i<=NR-2;i++){s+=a[i];c++} printf "%.0f", s/c}'; }
echo "A $(trim "${ta[@]}") ms   B $(trim "${tb[@]}") ms   ($A vs $B)"
rm -rf "$OUT"
