#!/usr/bin/env bash
# setup-linux-prereqs.sh — Install system packages required to build and run OpenStudio on Ubuntu/Debian.
# Run once before your first build: bash tools/setup-linux-prereqs.sh
set -euo pipefail

echo "=== OpenStudio Linux prerequisites setup ==="

sudo apt-get update

sudo apt-get install -y \
    build-essential \
    cmake \
    ninja-build \
    pkg-config \
    git \
    \
    libasound2-dev \
    libjack-jackd2-dev \
    \
    libwebkit2gtk-4.1-dev \
    libgtk-3-dev \
    \
    libgl1-mesa-dev \
    libglu1-mesa-dev \
    libfreetype6-dev \
    libfontconfig1-dev \
    libcurl4-openssl-dev \
    \
    libx11-dev \
    libxext-dev \
    libxrandr-dev \
    libxi-dev \
    libxinerama-dev \
    libxcursor-dev \
    libxcomposite-dev \
    \
    ffmpeg \
    python3 \
    python3-venv

# webkit2gtk-4.1 may not be available on Ubuntu 22.04 — fall back to 4.0
if ! dpkg -l libwebkit2gtk-4.1-dev &>/dev/null; then
    echo "webkit2gtk-4.1 not found, installing 4.0 fallback..."
    sudo apt-get install -y libwebkit2gtk-4.0-dev
fi

echo ""
echo "All prerequisites installed."
echo "You can now run: python build.py dev --run"
