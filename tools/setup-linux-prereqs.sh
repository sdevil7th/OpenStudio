#!/usr/bin/env bash
# setup-linux-prereqs.sh — Install system packages required to build and run OpenStudio on Ubuntu/Debian.
# Run once before your first build: bash tools/setup-linux-prereqs.sh
set -euo pipefail

echo "=== OpenStudio Linux prerequisites setup ==="

sudo apt-get update

# First boot may still be applying distribution security updates. Wait for its
# package transaction rather than failing halfway through prerequisite setup.
sudo apt-get -o DPkg::Lock::Timeout=120 install -y \
    build-essential \
    cmake \
    ninja-build \
    pkg-config \
    dpkg-dev \
    desktop-file-utils \
    appstream \
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
    libsecret-tools \
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
    python-is-python3 \
    python3-venv

echo ""
echo "All prerequisites installed."
echo "You can now run: python build.py dev --run"
