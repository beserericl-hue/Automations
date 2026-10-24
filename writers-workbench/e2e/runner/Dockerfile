# writer-e2e: the E2E suite, run on Railway against the DEV deployment.
#
# Why on Railway and not in GitHub Actions: the authenticated specs need DEV's Supabase service key,
# and no credential is kept in GitHub. This service reads its keys from Railway (reference variables
# to the WritersWorkbench service), so they never leave Railway.
#
# Build context is the service root, /writers-workbench. Only the suite is copied in; it needs
# nothing from the app but @playwright/test and dotenv.

FROM mcr.microsoft.com/playwright:v1.59.1-noble

WORKDIR /app
COPY e2e/runner/package.json ./package.json
RUN npm install --no-audit --no-fund

COPY playwright.config.ts ./playwright.config.ts
COPY e2e ./e2e

CMD ["bash", "e2e/runner/run.sh"]
