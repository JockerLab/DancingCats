#!/usr/bin/env bash
set -euo pipefail

if (( $# != 2 )); then
  echo "Usage: $0 INPUT OUTPUT" >&2
  exit 2
fi

input_file=$1
output_file=$2

if [[ ! -f "$input_file" ]]; then
  echo "Input file does not exist: $input_file" >&2
  exit 1
fi

mkdir -p "$(dirname "$output_file")"

# Preserve the complete 11.8-second reference in its original direction. Only
# the empty vertical margins and green background are removed.
ffmpeg -hide_banner -y \
  -i "$input_file" \
  -filter_complex "[0:v]fps=30,crop=608:690:0:240,chromakey=color=0x00FF00:similarity=0.14:blend=0.055,despill=type=green:mix=0.75,setpts=PTS-STARTPTS,format=yuva420p[out]" \
  -map "[out]" \
  -an \
  -c:v libvpx-vp9 \
  -pix_fmt yuva420p \
  -crf 29 \
  -b:v 0 \
  -row-mt 1 \
  -auto-alt-ref 0 \
  "$output_file"

echo "Created full-length transparent video: $output_file"
