# Automations

This repository stores n8n automation workflows.

---

## Website Leads to Google Sheets

An n8n workflow that receives website form submissions via webhook, validates required fields, checks for duplicate emails, and appends new leads to a Google Sheet.

### How It Works

1. A website contact form sends a POST request to the n8n webhook endpoint
2. A Code node validates that `email`, `first_name`, and `consent` are present
3. Fields are normalized (email lowercased, phone stripped to digits, full name generated)
4. The email is looked up in Google Sheets to detect duplicates
5. New leads are appended to the spreadsheet; duplicates are rejected

### Webhook Endpoint

```
POST https://YOUR_N8N_DOMAIN/webhook/leads/new
Content-Type: application/json
```

### Request Body

```json
{
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
```

**Required fields:** `email`, `first_name`, `consent` (must be `true`)

**Optional fields:** `last_name`, `phone`, `company`, `message`, `source`, `page_url`, `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content`, `submitted_at`

### Responses

| Status | Condition | Example |
|--------|-----------|---------|
| `200` | Lead saved | `{"status": "success", "message": "Lead saved successfully", "email": "anna.koval@gmail.com"}` |
| `400` | Missing required fields | `{"status": "error", "message": "Missing required fields: email, first_name, and consent are required"}` |
| `409` | Duplicate email | `{"status": "error", "message": "Duplicate lead: a lead with this email already exists", "email": "anna.koval@gmail.com"}` |

### Workflow Architecture

```
Webhook POST /leads/new
        |
        v
  Code - Validate Fields
  (email, first_name, consent)
        |
        v
  Validation passed?
   +---YES---+----NO----+
   v                    v
Normalize          Respond 400
 Fields
   |
   v
Search Duplicate
(Google Sheets lookup by email)
   |
   v
 Duplicate?
 +---NO----+---YES---+
 v                   v
Append Row       Respond 409
   |
   v
Respond 200
```

### Nodes (10 total)

| Node | Type | Description |
|------|------|-------------|
| **Webhook - Receive Lead** | Webhook | POST `/leads/new` with `responseNode` mode |
| **Code - Validate Fields** | Code | JavaScript validation: checks email, first_name, consent; outputs `_validationResult: "pass"/"fail"` |
| **IF - Validate Required Fields** | If | Routes on `_validationResult` equals `"pass"` |
| **Set - Normalize Fields** | Set | Lowercases email, strips phone to digits, builds `full_name`, defaults missing optional fields to `""` |
| **Google Sheets - Search Duplicate** | Google Sheets | Get Rows filtered by email column. **Always Output Data** enabled so empty results pass through. |
| **IF - Duplicate Check** | If | Expression `$json.email ? "duplicate" : "new_lead"` equals `"new_lead"` |
| **Google Sheets - Append Row** | Google Sheets | Append or Update using email as match key. All 16 fields sourced from `$('Set - Normalize Fields')`. |
| **Respond Success** | Respond to Webhook | Returns HTTP 200 with success JSON |
| **Respond Validation Error** | Respond to Webhook | Returns HTTP 400 with missing fields error |
| **Respond Duplicate Error** | Respond to Webhook | Returns HTTP 409 with duplicate error |

### Google Sheet Columns

| Column | Source | Notes |
|--------|--------|-------|
| email | `body.email` | Lowercased and trimmed |
| first_name | `body.first_name` | Trimmed |
| last_name | `body.last_name` | Trimmed, defaults to `""` |
| full_name | Generated | `first_name + " " + last_name` |
| phone | `body.phone` | Non-digit characters removed |
| company | `body.company` | Defaults to `""` |
| message | `body.message` | Defaults to `""` |
| source | `body.source` | e.g., `"website_form"` |
| page_url | `body.page_url` | URL of the form page |
| utm_source | `body.utm_source` | Defaults to `""` |
| utm_medium | `body.utm_medium` | Defaults to `""` |
| utm_campaign | `body.utm_campaign` | Defaults to `""` |
| utm_term | `body.utm_term` | Defaults to `""` |
| utm_content | `body.utm_content` | Defaults to `""` |
| consent | `body.consent` | Boolean `true` |
| submitted_at | `body.submitted_at` | ISO 8601, defaults to `new Date().toISOString()` |

### Setup

See [SETUP_INSTRUCTIONS.md](SETUP_INSTRUCTIONS.md) for step-by-step installation and configuration.

### Files

| File | Description |
|------|-------------|
| `website-leads-workflow.json` | n8n workflow (import into n8n) |
| `website-leads-template.csv` | Google Sheets column headers |
| `SETUP_INSTRUCTIONS.md` | Detailed setup guide |
