# writer-e2e: the E2E suite, run on Railway against the DEV deployment.
#
# Why on Railway and not in GitHub Actions: the authenticated specs need DEV's Supabase service key,
# and no credential is kept in GitHub. This service reads its keys from Railway (reference variables
# to the WritersWorkbench service), so they never leave Railway.
#
# Railway service settings (DEV environment only): Root Directory = / (the repository root),
# Dockerfile path = writers-workbench/e2e/runner/Dockerfile, restart policy NEVER (one deploy is one
# run; a restart would run the suite again), watch paths /writers-workbench/**. The build root is the
# repository root on purpose: /writers-workbench holds the Workbench's own railway.toml, which Railway
# would read and so build the Workbench image here instead. The repository root has no Railway config.
#
# Only the suite is copied in; it needs nothing from the app but @playwright/test and dotenv.

FROM mcr.microsoft.com/playwright:v1.59.1-noble

WORKDIR /app
COPY writers-workbench/e2e/runner/package.json ./package.json
RUN npm install --no-audit --no-fund

COPY writers-workbench/playwright.config.ts ./playwright.config.ts
COPY writers-workbench/e2e ./e2e

CMD ["bash", "e2e/runner/run.sh"]
