# Dancing Kitten Trio

Local source reference: <https://www.youtube.com/shorts/N741OAlSZfY>.

The ignored `video.webm` keeps all three kittens as one indivisible object. The
opening in which they gather is retained as a non-loopable movement segment.

Reproduction command from the downloaded 1080×1920 reference:

```bash
ffmpeg -i reference.mp4 -map_metadata -1 -an \
  -vf "crop=900:580:90:586,chromakey=color=0x00FF00:similarity=0.14:blend=0.06,despill=type=green:mix=0.7,scale=450:290,format=yuva420p" \
  -r 30 -c:v libvpx-vp9 -pix_fmt yuva420p -crf 31 -b:v 0 \
  -row-mt 1 -auto-alt-ref 0 -g 15 -keyint_min 15 video.webm
tools/assets/add-reverse-bank.sh video.webm video.webm
```
