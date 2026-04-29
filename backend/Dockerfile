# KoraLink KYC — Dockerfile for Hugging Face Spaces v1.4.1
# ========================================================
# CRITICAL FIX: Using dlib-bin (prebuilt wheel) instead of dlib
# This avoids 3-5 minute C++ compilation that causes HF Spaces timeouts
# 
# Passport-style selfie validation features:
#   - Head pose estimation (yaw/pitch/roll detection)
#   - 68-point facial landmark detection  
#   - Plain background detection
#   - Shoulder visibility validation

FROM python:3.11-slim

# Install system dependencies (NO build tools needed for dlib-bin!)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 \
    libglib2.0-0 \
    libsm6 \
    libxext6 \
    libxrender1 \
    libx11-6 \
    tesseract-ocr \
    tesseract-ocr-eng \
    poppler-utils \
    wget \
    bzip2 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Upgrade pip first
RUN pip install --no-cache-dir --upgrade pip

# Install Python dependencies (dlib-bin installs instantly, no compilation!)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Create models directory
RUN mkdir -p /app/models

# Download OpenCV DNN face detector - deploy.prototxt
RUN wget -q -O /app/models/deploy.prototxt \
    https://raw.githubusercontent.com/opencv/opencv/master/samples/dnn/face_detector/deploy.prototxt

# Download OpenCV DNN face detector - caffemodel
RUN wget -q -O /app/models/res10_300x300_ssd_iter_140000.caffemodel \
    https://github.com/opencv/opencv_3rdparty/raw/dnn_samples_face_detector_20170830/res10_300x300_ssd_iter_140000.caffemodel

# Download dlib 68-point face landmark predictor (compressed)
RUN wget -q -O /app/models/shape_predictor_68_face_landmarks.dat.bz2 \
    http://dlib.net/files/shape_predictor_68_face_landmarks.dat.bz2

# Decompress the landmark model
RUN bzip2 -d /app/models/shape_predictor_68_face_landmarks.dat.bz2

# Verify models are present
RUN ls -lh /app/models/

COPY main.py .

EXPOSE 7860
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "7860"]