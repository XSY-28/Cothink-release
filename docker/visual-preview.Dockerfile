FROM node@sha256:0e5f906573693feaa1e21057ebdcfdb5bd5021f050b2dc7c9deceb629c7da2a8
COPY playwright-core /opt/preview/node_modules/playwright-core
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/preview/browsers
RUN sed -i 's|http://deb.debian.org|https://mirrors.tuna.tsinghua.edu.cn|g' /etc/apt/sources.list.d/debian.sources && printf 'Acquire::http::Timeout "30";\nAcquire::https::Timeout "30";\nAcquire::Retries "0";\n' > /etc/apt/apt.conf.d/99preview
RUN node /opt/preview/node_modules/playwright-core/cli.js install-deps chromium
RUN apt-get update && apt-get install -y --no-install-recommends fonts-noto-cjk && rm -rf /var/lib/apt/lists/*

COPY chromium_headless_shell-1248 /opt/preview/browsers/chromium_headless_shell-1248
COPY visual-preview.mjs /opt/preview/visual-preview.mjs
