# Website Leads to Google Sheets — N8N Workflow Setup

## Files Included

| File | Purpose |
|------|---------|
| `website-leads-workflow.json` | N8N workflow to import |
| `website-leads-template.csv` | Google Sheets header template |

---

## Step 1: Create the Google Sheet

1. Go to [Google Sheets](https://sheets.google.com) and create a new spreadsheet.
2. Name it **Website Leads** (or any name you prefer).
3. Import the headers: **File → Import → Upload** `website-leads-template.csv`, or manually type these headers in Row 1:

| A | B | C | D | E | F | G | H | I | J | K | L | M | N | O | P |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| email | first_name | last_name | full_name | phone | company | message | source | page_url | utm_source | utm_medium | utm_campaign | utm_term | utm_content | consent | submitted_at |

4. Note the **Spreadsheet ID** from the URL:
   ```
   https://docs.google.com/spreadsheets/d/SPREADSHEET_ID_HERE/edit
   ```

---

## Step 2: Set Up Google Sheets Credentials in N8N

1. In n8n, go to **Settings → Credentials → Add Credential → Google Sheets OAuth2 API** (or Service Account).
2. Follow the prompts to connect your Google account.
3. Ensure the credential has access to the spreadsheet you created.

---

## Step 3: Import the Workflow

1. In n8n, go to **Workflows → Import from File**.
2. Select `website-leads-workflow.json`.
3. The workflow will appear with all 10 nodes pre-configured.

---

## Step 4: Configure the Google Sheets Nodes

Two nodes need your spreadsheet connected:

### Node: "Google Sheets - Search Duplicate"
1. Click the node.
2. Select your Google Sheets credential.
3. Under **Document**, select your **Website Leads** spreadsheet.
4. Under **Sheet**, select the sheet with your headers.
5. Go to **Settings** tab and enable **Always Output Data** (required for duplicate check to work when no match is found).

### Node: "Google Sheets - Append Row"
1. Click the node.
2. Select your Google Sheets credential.
3. Under **Document**, select your **Website Leads** spreadsheet.
4. Under **Sheet**, select the same sheet.
5. The 16 column mappings are pre-configured and pull data from the **Set - Normalize Fields** node.

---

## Step 5: Pin Test Data to Webhook

To test the workflow in the n8n editor, pin sample data to the Webhook node:

1. Click the **Webhook - Receive Lead** node.
2. Click the **pin icon** or use **Pin data**.
3. Paste this JSON:

```json
[
  {
    "headers": {
      "host": "your-n8n-domain.app.n8n.cloud",
      "content-type": "application/json"
    },
    "params": {},
    "query": {},
    "body": {
      "first_name": "Anna",
      "last_name": "Koval",
      "email": "anna.koval@gmail.com",
      "phone": "+1 (415) 555-0199",
      "company": "Koval Studio",
      "message": "Need a quote for SEO",
      "source": "website_form",
      "page_url": "https://example.com/contact",
      "utm_source": "google",
      "utm_medium": "cpc",
      "utm_campaign": "brand_search",
      "utm_term": "marketing agency",
      "utm_content": "ad_1",
      "consent": true,
      "submitted_at": "2026-02-17T19:10:05+02:00"
    }
  }
]
```

---

## Step 6: Activate & Test

1. Click **Active** toggle (top right) to activate the workflow.
2. Your webhook URL will be:
   ```
   https://YOUR_N8N_DOMAIN/webhook/leads/new
   ```
   (For testing: `https://YOUR_N8N_DOMAIN/webhook-test/leads/new`)

3. Send a test POST request (success case — all required fields present):

```bash
curl -X POST https://YOUR_N8N_DOMAIN/webhook-test/leads/new \
  -H "Content-Type: application/json" \
  -d '{
    "first_name": "Anna",
    "last_name": "Koval",
    "email": "anna.koval@gmail.com",
    "phone": "+1 (415) 555-0199",
    "company": "Koval Studio",
    "message": "Need a quote for SEO",
    "source": "website_form",
    "page_url": "https://example.com/contact",
    "utm_source": "google",
    "utm_medium": "cpc",
    "utm_campaign": "brand_search",
    "utm_term": "marketing agency",
    "utm_content": "ad_1",
    "consent": true,
    "submitted_at": "2026-02-17T19:10:05+02:00"
  }'
```

**Expected response (200):**
```json
{
  "status": "success",
  "message": "Lead saved successfully",
  "email": "anna.koval@gmail.com"
}
```

4. Test the validation error case (missing email):

```bash
curl -X POST https://YOUR_N8N_DOMAIN/webhook-test/leads/new \
  -H "Content-Type: application/json" \
  -d '{
    "first_name": "Anna",
    "phone": "+14155550199",
    "consent": true
  }'
```

**Expected response (400):**
```json
{
  "status": "error",
  "message": "Missing required fields: email, first_name, and consent are required"
}
```

5. Test duplicate detection by sending the first (success) payload again:

**Expected response (409):**
```json
{
  "status": "error",
  "message": "Duplicate lead: a lead with this email already exists",
  "email": "anna.koval@gmail.com"
}
```

---

## Workflow Node-by-Node Explanation

| # | Node | Type | Purpose |
|---|------|------|---------|
| 1 | **Webhook - Receive Lead** | Webhook (POST `/leads/new`) | Receives incoming lead data from the website form |
| 2 | **Code - Validate Fields** | Code (JavaScript) | Checks that `email`, `first_name`, and `consent` are present; sets `_validationResult` to `"pass"` or `"fail"` |
| 3 | **IF - Validate Required Fields** | If | Routes to normalization on `"pass"` or to validation error on `"fail"` |
| 4 | **Set - Normalize Fields** | Set | Lowercases email, strips non-digits from phone, generates `full_name`, defaults empty fields to `""` |
| 5 | **Google Sheets - Search Duplicate** | Google Sheets (Get Rows) | Looks up the email in the sheet to check for existing leads. **Always Output Data** must be enabled. |
| 6 | **IF - Duplicate Check** | If | Evaluates `$json.email ? "duplicate" : "new_lead"` — routes new leads to append, duplicates to error |
| 7 | **Google Sheets - Append Row** | Google Sheets (Append or Update) | Writes normalized lead data. Pulls all 16 fields from the **Set - Normalize Fields** node via `$('Set - Normalize Fields').item.json.*` |
| 8 | **Respond Success** | Respond to Webhook | Returns `200` JSON success response |
| — | **Respond Validation Error** | Respond to Webhook | Returns `400` JSON error for missing fields |
| — | **Respond Duplicate Error** | Respond to Webhook | Returns `409` JSON error for duplicate leads |

---

## Workflow Flow Diagram

```
Webhook POST /leads/new
        |
        v
  Code - Validate Fields
  (email, first_name, consent)
        |
        v
  _validationResult?
   +--"pass"--+--"fail"--+
   v                     v
Normalize           Respond 400
 Fields             (missing fields)
   |
   v
Search Duplicate
(Get Rows by email)
[Always Output Data: ON]
   |
   v
 Duplicate?
 +--new_lead--+--duplicate--+
 v                          v
Append Row              Respond 409
(from Set - Normalize)  (duplicate)
   |
   v
Respond 200
(success)
```

---

## Webhook Request Body Reference

### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `email` | string | Lead's email address (used as unique key) |
| `first_name` | string | Lead's first name |
| `consent` | boolean | Must be `true` — indicates consent to data collection |

### Optional Fields

| Field | Type | Description |
|-------|------|-------------|
| `last_name` | string | Lead's last name |
| `phone` | string | Phone number (non-digits stripped during normalization) |
| `company` | string | Company name |
| `message` | string | Message or inquiry text |
| `source` | string | Lead source identifier (e.g., `"website_form"`) |
| `page_url` | string | URL of the page where the form was submitted |
| `utm_source` | string | UTM source parameter |
| `utm_medium` | string | UTM medium parameter |
| `utm_campaign` | string | UTM campaign parameter |
| `utm_term` | string | UTM term parameter |
| `utm_content` | string | UTM content parameter |
| `submitted_at` | string | ISO 8601 timestamp (defaults to current time if omitted) |
