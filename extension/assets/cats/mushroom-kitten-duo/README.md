# Mushroom Kitten Duo

Local source reference: <https://www.youtube.com/shorts/lfVhos3qyik>.

The two kittens remain one indivisible object. The local WebM keeps the complete
9.866-second dance, crops the empty green-screen area and contains a reverse
bank for ping-pong playback.

Reproduction command from the downloaded 1080×1920 reference:

```bash
tools/assets/process-cats.sh reference.mp4 video.webm \
  0 "" 0x00FF00 0.14 0.055 960:1080:86:704 480
```
