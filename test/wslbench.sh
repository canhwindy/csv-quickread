#!/bin/bash
# Times fresh runs of an entry's main.ts on the practice cases, pinned to one CPU, as user+sys
# seconds per run (the grader's CPU time, before it subtracts its do-nothing control).
# Usage (inside WSL): bash test/wslbench.sh <entry dir> <kit dir> [runs]
NODE=$(ls -d ~/n22/node-v22.23.5-linux-x64/bin/node)
ENTRY=$1
KIT=$2
RUNS=${3:-10}
OUT=$(mktemp -d)
export MAKEFUN_INPUT_DIR=$KIT/practice/input MAKEFUN_OUTPUT_DIR=$OUT
cd "$ENTRY"
times=()
for i in $(seq 1 "$RUNS"); do
  t=$( { /usr/bin/time -f "%U %S" taskset -c 0 "$NODE" main.ts > /dev/null; } 2>&1 | tail -1 )
  times+=("$(echo "$t" | awk '{printf "%.0f", ($1+$2)*1000}')")
done
sorted=$(printf '%s\n' "${times[@]}" | sort -n | tr '\n' ' ')
echo "cpu ms per run (sorted): $sorted"
printf '%s\n' "${times[@]}" | sort -n | awk '{a[NR]=$1} END {s=0;c=0;for(i=3;i<=NR-2;i++){s+=a[i];c++} printf "trimmed mean: %.0f ms\n", s/c}'
rm -rf "$OUT"
