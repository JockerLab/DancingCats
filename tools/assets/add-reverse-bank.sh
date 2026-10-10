#!/usr/bin/env bash
set -euo pipefail

if (( $# != 2 )); then
  echo "Usage: $0 FORWARD_WEBM OUTPUT_WEBM" >&2
  exit 2
fi

input_file=$1
output_file=$2

if [[ ! -f "$input_file" ]]; then
  echo "Input file does not exist: $input_file" >&2
  exit 1
fi

mkdir -p "$(dirname "$output_file")"
temporary_file=$(mktemp --suffix=.webm)
trap 'rm -f "$temporary_file"' EXIT

# Keep a single media element in the extension: the first half contains the
# original frames and the second half contains the same frames in reverse.
ffmpeg -hide_banner -y \
  -c:v libvpx-vp9 \
  -i "$input_file" \
  -map_metadata -1 \
  -filter_complex \
    "[0:v]format=yuva420p,split=2[forward-in][reverse-in];[forward-in]setpts=PTS-STARTPTS[forward];[reverse-in]reverse,setpts=PTS-STARTPTS[reverse];[forward][reverse]concat=n=2:v=1:a=0,format=yuva420p[out]" \
  -map "[out]" \
  -an \
  -c:v libvpx-vp9 \
  -pix_fmt yuva420p \
  -crf 31 \
  -b:v 0 \
  -row-mt 1 \
  -auto-alt-ref 0 \
  -g 15 \
  -keyint_min 15 \
  "$temporary_file"

mv "$temporary_file" "$output_file"
trap - EXIT
echo "Created forward + reverse WebM: $output_file"
