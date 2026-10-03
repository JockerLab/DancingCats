#!/usr/bin/env bash
set -euo pipefail

if (( $# < 2 )); then
  echo "Usage: $0 INPUT OUTPUT [START] [DURATION] [KEY_COLOR] [SIMILARITY] [BLEND]" >&2
  exit 2
fi

input_file=$1
output_file=$2
start_time=${3:-0}
duration=${4:-}
key_color=${5:-0x00FF00}
similarity=${6:-0.18}
blend=${7:-0.08}

if [[ ! -f "$input_file" ]]; then
  echo "Input file does not exist: $input_file" >&2
  exit 1
fi

mkdir -p "$(dirname "$output_file")"

duration_args=()
if [[ -n "$duration" ]]; then
  duration_args=(-t "$duration")
fi

ffmpeg -hide_banner -y \
  -ss "$start_time" \
  -i "$input_file" \
  "${duration_args[@]}" \
  -an \
  -vf "chromakey=color=${key_color}:similarity=${similarity}:blend=${blend},despill=type=green:mix=0.7,format=yuva420p" \
  -r 30 \
  -c:v libvpx-vp9 \
  -pix_fmt yuva420p \
  -crf 31 \
  -b:v 0 \
  -row-mt 1 \
  -auto-alt-ref 0 \
  "$output_file"

echo "Created: $output_file"
echo "Inspect transparency and tune key color/similarity/blend before shipping."
