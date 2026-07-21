# Uiland UI Detector Deployment

This folder turns the existing PyTorch UI detector into a small API service.

The production frontend should call this service with sampled video frames. The service returns timestamp-ready boxes for password, PIN, OTP, keyboard, and input privacy redactions.

## What Goes Where

Local folder:

```txt
ui-detector-service/
```

VPS folder:

```txt
/opt/uiland/ui-detector/
```

Public API domain:

```txt
https://detector.uiland.design
```

Keep this separate from `api.uiland.design` and `extract.uiland.design` so the ML model cannot slow down your normal APIs.

## Step 1: Prepare The Local Folder

From PowerShell on your Windows machine:

```powershell
cd C:\Users\gudos\Documents\MobileApps-Editor\rendervideos\ui-detector-service
.\scripts\prepare-local-artifacts.ps1
```

This copies these files into `ui-detector-service\models`:

```txt
faster_rcnn_uiland_checkpoint_stopped.pth
ui_detector_label_map.json
```

The checkpoint is large and ignored by git on purpose.

## Step 2: Upload To The VPS

From PowerShell:

```powershell
scp -r C:\Users\gudos\Documents\MobileApps-Editor\rendervideos\ui-detector-service root@YOUR_VPS_IP:/opt/uiland/ui-detector
```

If `/opt/uiland` does not exist on the VPS:

```bash
ssh root@YOUR_VPS_IP
mkdir -p /opt/uiland
exit
```

Then run the `scp` command again.

## Step 3: Install Python Dependencies On The VPS

SSH into the VPS:

```bash
ssh root@YOUR_VPS_IP
cd /opt/uiland/ui-detector
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
pip install -r requirements-torch-cpu.txt
```

This installs CPU PyTorch. If the VPS has NVIDIA GPU drivers already working, install the matching CUDA PyTorch wheel instead of `requirements-torch-cpu.txt`.

## Step 4: Create The Environment File

On the VPS:

```bash
cd /opt/uiland/ui-detector
cp .env.example .env
nano .env
```

Make sure these paths are correct:

```txt
UI_DETECTOR_CHECKPOINT=/opt/uiland/ui-detector/models/faster_rcnn_uiland_checkpoint_stopped.pth
UI_DETECTOR_LABEL_MAP=/opt/uiland/ui-detector/models/ui_detector_label_map.json
```

For an 8 GB CPU VPS, keep:

```txt
UI_DETECTOR_CONCURRENCY=1
UI_DETECTOR_MAX_SIDE=960
```

## Step 5: Test It Manually

On the VPS:

```bash
cd /opt/uiland/ui-detector
source .venv/bin/activate
uvicorn api:app --host 127.0.0.1 --port 8092
```

In another SSH tab:

```bash
curl http://127.0.0.1:8092/health
curl -X POST http://127.0.0.1:8092/warmup
```

If `/warmup` returns `ok: true`, the model loaded.

## Step 6: Install As A Background Service

Stop the manual `uvicorn` process with `Ctrl+C`.

Then:

```bash
cp /opt/uiland/ui-detector/deploy/uiland-ui-detector.service /etc/systemd/system/uiland-ui-detector.service
systemctl daemon-reload
systemctl enable uiland-ui-detector
systemctl start uiland-ui-detector
systemctl status uiland-ui-detector
```

If you need logs:

```bash
journalctl -u uiland-ui-detector -f
```

## Step 7: Add Nginx

Copy the Nginx config:

```bash
cp /opt/uiland/ui-detector/deploy/nginx-detector.uiland.design.conf /etc/nginx/sites-available/detector.uiland.design
ln -s /etc/nginx/sites-available/detector.uiland.design /etc/nginx/sites-enabled/detector.uiland.design
nginx -t
systemctl reload nginx
```

## Step 8: Add DNS

In your DNS provider, add:

```txt
Type: A
Name: detector
Value: YOUR_VPS_IP
```

Wait until it resolves:

```bash
ping detector.uiland.design
```

## Step 9: Add HTTPS

If you use Certbot:

```bash
certbot --nginx -d detector.uiland.design
```

Then test:

```bash
curl https://detector.uiland.design/health
curl -X POST https://detector.uiland.design/warmup
```

## Step 10: How The Frontend Should Use It

The frontend should not upload full videos to this detector.

Correct flow:

```txt
1. User uploads video.
2. Browser samples frames in the background.
3. Browser downscales each sampled frame.
4. Browser sends small JPEG frames to /detect-ui.
5. API returns boxes.
6. Browser stores boxes as timestamped auto redactions.
7. Export uses cached boxes.
```

Do not detect every video frame.

Good default:

```txt
1 sampled frame per second
0.4s padding before each detection
0.4s padding after each detection
```

Password, PIN, OTP, and keyboard detections should use `hide`, not soft blur. Blur can leak typing position.

## API Request Example

```bash
curl -X POST https://detector.uiland.design/detect-ui \
  -F "file=@sample.jpg" \
  -F "frame_id=clip1_00m12s" \
  -F "timestamp_sec=12.0"
```

## API Response Shape

```json
{
  "ok": true,
  "frame_id": "clip1_00m12s",
  "timestamp_sec": 12.0,
  "width": 590,
  "height": 1280,
  "count": 2,
  "detections": [
    {
      "raw_type": "Password Input",
      "type": "input",
      "bbox": [24, 180, 570, 238],
      "bbox_norm": [0.040678, 0.140625, 0.966102, 0.185938],
      "confidence": 0.84,
      "privacy_action": "hide",
      "source": "ui-auto-password-input",
      "pad_before_sec": 0.4,
      "pad_after_sec": 0.4
    }
  ]
}
```

## Safe VPS Settings

For an 8 GB CPU VPS:

```txt
UI_DETECTOR_CONCURRENCY=1
UI_DETECTOR_MAX_SIDE=960
UI_DETECTOR_MAX_DETECTIONS=80
```

Only increase concurrency after checking RAM.

## If It Feels Slow

First reduce the amount of detection work:

```txt
sample every 1.5s instead of every 1s
lower UI_DETECTOR_MAX_SIDE from 960 to 720
send JPEG quality around 0.65
cache every result by video id + timestamp
```

Do not increase concurrency first. That is how the VPS starts swapping and everything gets miserable.

