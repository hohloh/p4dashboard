<h1 align="center">P4 Dashboard</h1>
<h3 align="center">Lightweight WebUI for Perforce (P4)</h3>
<br/>
<p align="center">
  <img alt="GPL 2.0 License" src="https://img.shields.io/badge/License-GPL%202.0-orange"/>
  <img alt="Current Release" src="https://img.shields.io/badge/Release-0.1.0-blue"/>
</p>
<br/>
Since P4V doesn't offer a WebUI or mobile app, this project provides a lightweight Node.js dashboard for Perforce (P4), optimized for mobile viewing and designed for deployment in standard Docker environments.
<br/>

## Prerequisites

- Docker checks for installed `p4` CLI (auto-installed in image)
- A running Perforce server
- A .p4trust entry for the Perforce server

## Quick Start

### 1. Load Image
**Option A: Load Pre-built Image**
If you downloaded the `p4dashboard.tar` image:
```bash
docker load -i p4dashboard.tar
```

**Option B: Build from Source**
```bash
docker build -t p4dashboard:0.1.0 .
```

### 2. Run with Docker Compose

```bash
docker-compose up -d
```

The app will be available at `http://localhost:4444`.

## Configuration

- **Data Persistence**: Credentials are stored in `./data`, mapped to a volume in `docker-compose.yml`.
- **P4TRUST**: A .p4trust entry needs to be mapped if you are connecting to a Perforce server for the first time from the host device.
- **Ports**: Default port is `4444`.

## Development

To run locally:

```bash
npm install
npm start
```
