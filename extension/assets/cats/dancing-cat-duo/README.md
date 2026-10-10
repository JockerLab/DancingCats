# Dancing Cat Duo

Local source reference: <https://www.youtube.com/shorts/ZdNn1JBNrRU>.

Both cats remain one indivisible object. The local WebM keeps the complete
14.866-second dance, crops the empty green-screen area and contains a reverse
bank for safe ping-pong segments.

Reproduction command from the downloaded 1080×1920 reference:

```bash
tools/assets/process-cats.sh reference.mp4 video.webm \
  0 "" 0x00FF00 0.14 0.055 1024:1400:28:340 512
```
