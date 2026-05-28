# ==============================================================================
# smoothcomp-scrubber-ui
# Self-contained image: FFmpeg + dav1d + OpenCV + Tesseract + web UI.
# ==============================================================================

FROM ubuntu:24.04 AS builder

ARG DEBIAN_FRONTEND=noninteractive
ARG FFMPEG_VERSION=7.1
ARG OPENCV_VERSION=4.10.0

RUN apt-get update && apt-get install -y \
    build-essential \
    cmake \
    ninja-build \
    pkg-config \
    git \
    curl \
    yasm \
    nasm \
    python3 \
    python3-dev \
    python3-numpy \
    python3-pip \
    libopenblas-dev \
    liblapack-dev \
    libjpeg-dev \
    libpng-dev \
    libtiff-dev \
    zlib1g-dev \
    libdav1d-dev \
    ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# ==============================================================================
# Build FFmpeg with dav1d
# ==============================================================================

RUN curl -LO https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz && \
    tar xf ffmpeg-${FFMPEG_VERSION}.tar.xz

WORKDIR /build/ffmpeg-${FFMPEG_VERSION}

RUN ./configure \
    --prefix=/opt/ffmpeg \
    --enable-gpl \
    --enable-version3 \
    --enable-shared \
    --disable-static \
    --disable-debug \
    --disable-doc \
    --enable-libdav1d \
    --enable-pic \
 && make -j"$(nproc)" \
 && make install

ENV PKG_CONFIG_PATH=/opt/ffmpeg/lib/pkgconfig

# ==============================================================================
# Build OpenCV
# ==============================================================================

WORKDIR /build

RUN curl -L https://github.com/opencv/opencv/archive/${OPENCV_VERSION}.tar.gz \
    | tar xz

RUN mkdir /build/opencv-build

WORKDIR /build/opencv-build

RUN cmake -G Ninja ../opencv-${OPENCV_VERSION} \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_INSTALL_PREFIX=/usr/local \
    -DBUILD_SHARED_LIBS=ON \
    -DBUILD_LIST=core,imgproc,imgcodecs,videoio,highgui,python3 \
    -DBUILD_opencv_python3=ON \
    -DBUILD_opencv_python2=OFF \
    -DBUILD_TESTS=OFF \
    -DBUILD_PERF_TESTS=OFF \
    -DBUILD_EXAMPLES=OFF \
    -DBUILD_DOCS=OFF \
    -DBUILD_JAVA=OFF \
    -DBUILD_PROTOBUF=OFF \
    -DBUILD_opencv_apps=OFF \
    -DWITH_FFMPEG=ON \
    -DWITH_GSTREAMER=OFF \
    -DWITH_QT=OFF \
    -DWITH_GTK=OFF \
    -DWITH_OPENCL=OFF \
    -DWITH_TBB=OFF \
    -DWITH_IPP=OFF \
    -DWITH_OPENMP=OFF \
    -DWITH_1394=OFF \
    -DWITH_V4L=OFF \
    -DWITH_EIGEN=OFF \
    -DWITH_WEBP=OFF \
    -DWITH_JASPER=OFF \
    -DWITH_OPENEXR=OFF \
    -DPYTHON3_EXECUTABLE=$(which python3) \
    -DPYTHON3_INCLUDE_DIR=$(python3 -c "from sysconfig import get_paths; print(get_paths()['include'])") \
    -DPYTHON3_PACKAGES_PATH=$(python3 -c "import site; print(site.getsitepackages()[0])") \
    -DOPENCV_PYTHON3_INSTALL_PATH=$(python3 -c "import site; print(site.getsitepackages()[0])") \
 && ninja \
 && ninja install

# ==============================================================================
# Runtime Image
# ==============================================================================

FROM ubuntu:24.04

ARG DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python3-numpy \
    pipx \
    libopenblas0 \
    libjpeg-turbo8 \
    libpng16-16 \
    libtiff6 \
    libdav1d7 \
    ca-certificates \
    tesseract-ocr \
    libtesseract-dev \
    curl \
    unzip \
 && rm -rf /var/lib/apt/lists/*

# copy deno binary in for yt-dlp to not warn about JS
COPY --from=denoland/deno:bin /deno /usr/local/bin/deno
RUN echo "--remote-components ejs:npm" > /etc/yt-dlp.conf

COPY --from=builder /opt/ffmpeg /opt/ffmpeg
COPY --from=builder /usr/local /usr/local

ENV LD_LIBRARY_PATH=/opt/ffmpeg/lib:/usr/local/lib:${LD_LIBRARY_PATH}
ENV PATH=/root/.local/bin:/opt/ffmpeg/bin:${PATH}

RUN pipx install pipenv yt-dlp \
 && pipenv --site-packages \
 && pipenv install pytesseract fastapi "uvicorn[standard]"

# Verify OpenCV + FFmpeg backend
RUN python3 -c "import cv2; print(cv2.__version__)"
RUN python3 - <<'PY'
import cv2
info = cv2.getBuildInformation()
if "FFMPEG:                      YES" not in info:
    raise RuntimeError("FFmpeg backend NOT enabled")
print("FFmpeg backend enabled")
PY

# Fetch scrubber scripts from source
ARG SCRUBBER_REF=main
RUN curl -fsSL "https://raw.githubusercontent.com/Felttrip/smoothcomp-scrubber/${SCRUBBER_REF}/get-smoothcomp-timestamps.py" \
        -o /usr/local/bin/get-smoothcomp-timestamps.py \
 && curl -fsSL "https://raw.githubusercontent.com/Felttrip/smoothcomp-scrubber/${SCRUBBER_REF}/make-clips.py" \
        -o /usr/local/bin/make-clips.py \
 && chmod u+x /usr/local/bin/get-smoothcomp-timestamps.py /usr/local/bin/make-clips.py

# Copy web app
COPY app /app

RUN mkdir -p /videos /outputs /config
VOLUME ["/videos", "/outputs", "/config"]

ENV VIDEOS_DIR=/videos
ENV OUTPUTS_DIR=/outputs
ENV CONFIG_DIR=/config

EXPOSE 8080

CMD ["pipenv", "run", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
