FROM debian:13
ENV DEBIAN_FRONTEND=noninteractive
# 1. Install dependencies
RUN apt-get update && apt-get install -y \
    gnupg \
    wget \
    curl \
    bzip2 \
    xz-utils \
    ca-certificates \
    xvfb \
    fluxbox \
    x11vnc \
    novnc \
    websockify \
    supervisor \
    python3 \
    python3-pip \
    firefox-esr \
    fonts-liberation \
    libasound2 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgcc-s1 \
    libgdk-pixbuf-2.0-0 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    libgbm1 \
    lsb-release \
    unzip \
    && apt-get clean
# --------------------------------------------------------------
# --- FIREFOX CONFIGURATION (FIX: Allow Unsigned Extensions) ---
# Debian's firefox-esr installs to /usr/lib/firefox-esr - confirmed live on
# an actual arm64 instance (readlink -f `which firefox-esr`).
RUN mkdir -p /usr/lib/firefox-esr/defaults/pref/ && \
    echo 'pref("general.config.filename", "mozilla.cfg");' > /usr/lib/firefox-esr/defaults/pref/autoconfig.js && \
    echo 'pref("general.config.obscure_value", 0);' >> /usr/lib/firefox-esr/defaults/pref/autoconfig.js && \
    echo '//' > /usr/lib/firefox-esr/mozilla.cfg && \
    echo 'lockPref("xpinstall.signatures.required", false);' >> /usr/lib/firefox-esr/mozilla.cfg && \
    echo 'lockPref("extensions.checkCompatibility.nightly", false);' >> /usr/lib/firefox-esr/mozilla.cfg
# --------------------------------------------------------------
# 2b. Set /tmp to be globally writable (Sticky Bit)
RUN chmod 1777 /tmp
# 3. Enable the full noVNC interface
RUN ln -s /usr/share/novnc/vnc.html /usr/share/novnc/index.html
WORKDIR /app
COPY . .
# Fix permissions for the startup script
RUN chmod +x /app/run.sh
CMD ["/app/run.sh"]
