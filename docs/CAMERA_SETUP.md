# Camera Integration Guide (RTSP / DVR / NVR vs HDMI Capture)

## Method 1: Direct RTSP / DVR / NVR (Recommended)

```
CCTV Camera -> DVR/NVR -> Local Shop LAN -> Python Edge Connector -> Outbound HTTPS/WSS -> Cloud Backend
```

1. Ensure the shop DVR/NVR and the local edge mini-PC are on the same LAN subnet.
2. Enable RTSP on the DVR/NVR (typically port `554`, e.g., `rtsp://user:pass@192.168.1.50:554/Streaming/Channels/101`).
3. Do **NOT** open router ports or configure port forwarding. The Python edge service initiates outbound HTTPS requests to `BACKEND_URL`.
4. Add the camera in **Camera Management** and run **Test Stream**.

## Method 2: HDMI / VGA Monitor Capture

```
DVR/NVR HDMI Out -> USB Capture Card -> Local Edge PC (/dev/video0) -> Python Vision Service
```

Use HDMI capture only when DVR RTSP streams are disabled or inaccessible. Because a DVR monitor typically displays a 4-up or 9-up grid, each camera receives 1/4th or 1/9th of the 1080p frame, reducing small-person detection accuracy compared to direct RTSP sub-streams.

## Method 3: Temporary Video Upload (MVP Testing)

Upload an `.mp4`, `.avi`, or `.mov` file in **Live Monitoring**. Files are stored ephemerally in `/tmp/retail-brain-uploads` and auto-purged after 30 minutes.
