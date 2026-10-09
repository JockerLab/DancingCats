#!/usr/bin/env bash
set -euo pipefail

if (( $# < 2 || $# > 3 )); then
  echo "Usage: $0 INPUT OUTPUT [MODEL]" >&2
  exit 2
fi

input_file=$1
output_file=$2
model=${3:-isnet-general-use}
rembg_command=${REMBG_COMMAND:-rembg}

if [[ ! -f "$input_file" ]]; then
  echo "Input file does not exist: $input_file" >&2
  exit 1
fi
if ! command -v "$rembg_command" >/dev/null 2>&1; then
  echo "rembg executable is unavailable: $rembg_command" >&2
  exit 1
fi

work_dir=$(mktemp -d "${TMPDIR:-/tmp}/dancing-cats-rembg.XXXXXX")
frames_dir="$work_dir/frames"
cutouts_dir="$work_dir/cutouts"
mkdir -p "$frames_dir" "$cutouts_dir" "$(dirname "$output_file")"
trap 'rm -rf "$work_dir"' EXIT

ffmpeg -hide_banner -loglevel error -y \
  -i "$input_file" \
  -map_metadata -1 \
  -vf "fps=30" \
  "$frames_dir/frame-%06d.png"

"$rembg_command" p -m "$model" "$frames_dir" "$cutouts_dir"

ffmpeg -hide_banner -loglevel error -y \
  -framerate 30 \
  -i "$cutouts_dir/frame-%06d.png" \
  -map_metadata -1 \
  -an \
  -c:v libvpx-vp9 \
  -pix_fmt yuva420p \
  -crf 29 \
  -b:v 0 \
  -row-mt 1 \
  -auto-alt-ref 0 \
  -g 15 \
  -keyint_min 15 \
  "$output_file"

echo "Created transparent VP9 asset: $output_file"
