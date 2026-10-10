# Solo Dancing Cat

Local source reference: <https://www.youtube.com/shorts/fVuK4D7zQYc>.

The ignored `video.webm` is one indivisible cat object. It is cropped only around
the green-screen stage and keeps the complete 7.466-second dance in its original
direction.

Reproduction command from the downloaded 1080×1920 reference:

```bash
ffmpeg -i reference.mp4 -map_metadata -1 -an \
  -vf "crop=880:1064:16:392,chromakey=color=0x00FF00:similarity=0.14:blend=0.06,despill=type=green:mix=0.7,scale=440:532,format=yuva420p" \
  -r 30 -c:v libvpx-vp9 -pix_fmt yuva420p -crf 31 -b:v 0 \
  -row-mt 1 -auto-alt-ref 0 -g 15 -keyint_min 15 video.webm
tools/assets/add-reverse-bank.sh video.webm video.webm
```
