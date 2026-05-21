FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

# 1. Install dependencies (Added curl, bzip2, and xz-utils for the manual Firefox Dev install)
RUN sed -i 's/archive.ubuntu.com/us-east-1.ec2.archive.ubuntu.com/g' /etc/apt/sources.list && \
    sed -i 's/security.ubuntu.com/us-east-1.ec2.archive.ubuntu.com/g' /etc/apt/sources.list && \
    apt-get update && apt-get install -y \
    software-properties-common \
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
    fonts-liberation \
    libasound2 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgcc-s1 \
    libgdk-pixbuf2.0-0 \
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

# --- NEW SECTION: Install Firefox ---
# Using curl -f -L to handle redirects and fail on error, and tar -xf to auto-detect formats.
# Pinned to stable Firefox 151.0
RUN curl -f -L "https://archive.mozilla.org/pub/firefox/releases/151.0/linux-x86_64/en-US/firefox-151.0.tar.xz" -o /tmp/firefox.tar.xz \
    && tar -xf /tmp/firefox.tar.xz -C /opt \
    && ln -s /opt/firefox/firefox /usr/bin/firefox \
    && rm /tmp/firefox.tar.xz
# ------------------------------------------------------

# --- NEW SECTION: Install Geckodriver Manually ---
RUN wget -q "https://github.com/mozilla/geckodriver/releases/download/v0.34.0/geckodriver-v0.34.0-linux64.tar.gz" -O /tmp/geckodriver.tar.gz \
    && tar -xzf /tmp/geckodriver.tar.gz -C /usr/local/bin \
    && rm /tmp/geckodriver.tar.gz
# ------------------------------------------------

# --- Install Python Libraries ---
RUN pip3 install selenium
# --------------------------------

# --- FIREFOX CONFIGURATION (FIX: Allow Unsigned Extensions) ---
# For Developer Edition, these files live in /opt/firefox
RUN mkdir -p /opt/firefox/browser/defaults/preferences/ && \
    echo 'pref("general.config.filename", "mozilla.cfg");' > /opt/firefox/browser/defaults/preferences/autoconfig.js && \
    echo 'pref("general.config.obscure_value", 0);' >> /opt/firefox/browser/defaults/preferences/autoconfig.js && \
    echo '//' > /opt/firefox/mozilla.cfg && \
    echo 'lockPref("xpinstall.signatures.required", false);' >> /opt/firefox/mozilla.cfg && \
    echo 'lockPref("extensions.checkCompatibility.nightly", false);' >> /opt/firefox/mozilla.cfg
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
