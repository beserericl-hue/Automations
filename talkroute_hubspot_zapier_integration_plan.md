# TalkRoute + HubSpot Integration via Zapier — Implementation Guide

**Prepared:** 2026-04-08
**For:** Tech implementor
**Estimated Zapier plan needed:** Professional (multi-step Zaps)

---

## Table of Contents

1. [Prerequisites & Access Required](#1-prerequisites--access-required)
2. [TalkRoute Zapier Authentication Setup](#2-talkroute-zapier-authentication-setup)
3. [HubSpot Zapier Authentication Setup](#3-hubspot-zapier-authentication-setup)
4. [Understanding TalkRoute's Data Model](#4-understanding-talkroutes-data-model)
5. [Zap 1: Log Completed Calls to HubSpot](#5-zap-1-log-completed-calls-to-hubspot)
6. [Zap 2: Create Tasks from Voicemails](#6-zap-2-create-tasks-from-voicemails)
7. [Zap 3: Log SMS Messages to Contact Timeline](#7-zap-3-log-sms-messages-to-contact-timeline)
8. [Testing & Validation Checklist](#8-testing--validation-checklist)
9. [Known Limitations & Gotchas](#9-known-limitations--gotchas)
10. [Ongoing Maintenance](#10-ongoing-maintenance)

---

## 1. Prerequisites & Access Required

### Accounts Needed

| System | Access Level Required | Why |
|--------|----------------------|-----|
| TalkRoute | **Administrator** | Only admins can generate Personal Access Tokens for Zapier |
| HubSpot | **Super Admin** | Required to authorize the Zapier ↔ HubSpot OAuth connection |
| Zapier | **Professional plan or higher** | Free plan limited to 2-step Zaps; these workflows need 3-5 steps each. Free plan also limited to 100 tasks/month — each multi-step Zap execution counts each step as a task (e.g., a 4-step Zap = 4 tasks per trigger event) |

### Before Starting

- [ ] Confirm TalkRoute account is on a plan that includes Zapier integration (check with TalkRoute support if unsure — the feature is currently in **beta**)
- [ ] Confirm HubSpot account has API/integration access (available on all paid plans; free CRM works too but with limited properties)
- [ ] Have a test phone number available to place inbound calls, leave voicemails, and send SMS to your TalkRoute number

---

## 2. TalkRoute Zapier Authentication Setup

### Step-by-step: Get Your Personal Access Token

1. Log into the TalkRoute Control Panel at **cp.talkroute.com**
2. Click on your **User Profile** (top-right of the control panel)
3. Scroll to the **"Personal Access Token"** section
4. Click **"Copy to Clipboard"** to copy the token
5. Save this token somewhere secure — you will paste it into Zapier

### Important Notes

- This token is **tied to the admin user** who generated it — Zaps will only fire for events that this user has access to
- If the admin account is deactivated or the token is regenerated, all Zaps will stop working
- There is **no OAuth flow** for TalkRoute — it uses this static token method

### Connect TalkRoute in Zapier

1. Go to **zapier.com** and log in
2. Click **"Create Zap"** (or go to **My Apps** → **Add Connection**)
3. Search for **"Talkroute"** (one word, no space)
4. When prompted for authentication, paste your **Personal Access Token**
5. Zapier will verify the connection — you should see a green checkmark

---

## 3. HubSpot Zapier Authentication Setup

### Connect HubSpot in Zapier

1. In Zapier, go to **My Apps** → **Add Connection** → search **"HubSpot"**
2. Click **Connect** — this opens an OAuth popup window
3. Log into HubSpot with a **Super Admin** account
4. Select the **HubSpot portal/account** you want to connect
5. Review the permissions Zapier is requesting and click **"Connect app"**
6. You should see HubSpot appear in your connected apps list

### Required HubSpot Permissions

Zapier will request access to:
- Contacts (read/write)
- Engagements (read/write)
- Tasks (read/write)
- Notes (read/write)

All of these are needed for this integration.

---

## 4. Understanding TalkRoute's Data Model

TalkRoute's Zapier integration is **one-directional: triggers only**. You can send data FROM TalkRoute to other apps, but you CANNOT send data back into TalkRoute. There are no Zapier "actions" for TalkRoute.

### Trigger 1: Phone Call Completed (Instant)

Fires immediately when any inbound or outbound call ends.

| Field Name | Description | Example Value |
|-----------|-------------|---------------|
| `call_timestamp` | Date/time the call occurred (includes timezone) | `2026-04-08T14:32:00-04:00` |
| `call_result` | Outcome of the call | `answered`, `missed`, `hangup` |
| `call_direction` | Whether the call was inbound or outbound | `inbound` or `outbound` |
| `call_duration` | Length of the call in seconds | `127` |
| `talkroute_number` | The TalkRoute virtual number that was called | `+18005551234` |
| `caller_number` | The caller's phone number | `+14435551234` |
| `caller_id_name` | The caller's name (from carrier CNAM lookup) | `JOHN SMITH` or blank |

**Note on caller_id_name:** This field depends on the caller's carrier providing CNAM data. Many mobile carriers do NOT provide this, so this field will frequently be blank. Do not rely on it as a primary identifier.

### Trigger 2: New Voice Message (Instant)

Fires when a voicemail is left.

| Field Name | Description | Example Value |
|-----------|-------------|---------------|
| `arrival_timestamp` | Date/time the voicemail was received (includes timezone) | `2026-04-08T14:35:00-04:00` |
| `call_outcome` | How the call ended before voicemail | `missed`, `hangup` |
| `message_duration` | Length of the voicemail in seconds | `45` |
| `talkroute_number` | The TalkRoute number that was called | `+18005551234` |
| `caller_number` | The caller's phone number | `+14435551234` |
| `transcription` | Text transcription of the voicemail (if transcription is enabled in TalkRoute settings) | `"Hi, this is John calling about..."` |
| `voicemail_box_name` | Name of the voicemail box that received the message | `Sales`, `Support`, etc. |

**Note on transcription:** This field is only populated if you have voicemail transcription enabled in your TalkRoute plan/settings. If disabled, this field will be blank.

### Trigger 3: New Text Message (Instant)

Fires when an SMS is sent or received.

| Field Name | Description | Example Value |
|-----------|-------------|---------------|
| `message_timestamp` | Date/time of the message (includes timezone) | `2026-04-08T14:40:00-04:00` |
| `direction` | Whether the message was inbound or outbound | `inbound` or `outbound` |
| `sender_number` | Phone number that sent the message | `+14435551234` |
| `recipient_number` | Phone number that received the message | `+18005551234` |
| `message_body` | The text content of the SMS | `"I'd like to schedule a meeting"` |

**Note on MMS:** Multimedia messages (images, videos) will show a **blank message_body**. Only plain text SMS content is captured.

---

## 5. Zap 1: Log Completed Calls to HubSpot

This is the most important Zap. It ensures every completed phone call creates or updates a contact and logs a call engagement on their timeline.

### Zap Architecture (4 steps)

```
Step 1: TRIGGER — TalkRoute: Phone Call Completed
    ↓
Step 2: SEARCH — HubSpot: Find Contact (by phone number)
    ↓
Step 3: ACTION — HubSpot: Create Contact (only if Step 2 found nothing)
    ↓
Step 4: ACTION — HubSpot: Create Engagement (type: CALL)
```

### Step 1: Trigger — TalkRoute Phone Call Completed

1. In Zapier, click **"Create Zap"**
2. For the trigger app, search **"Talkroute"**
3. Select the event: **"Phone Call Completed"**
4. Click **Continue**, select your TalkRoute account
5. Click **"Test trigger"** — Zapier will attempt to pull a recent call record
   - **If test data is blank:** This is normal if there are no recent calls. You can skip the test and configure with sample data, then test live later.
6. Click **Continue** after the trigger is set up

### Step 2: Search — HubSpot Find Contact

1. Click the **"+"** to add a step
2. Search for **"HubSpot"** as the app
3. Select the action: **"Find Contact"**
4. Configure the search:

| Setting | Value |
|---------|-------|
| **Search Property Name** | `phone` |
| **Search Property Value** | Map to **Step 1 → Caller Number** (click the field, select from the TalkRoute data) |
| **Create HubSpot Contact if it doesn't exist yet?** | **No** (we'll handle creation in a separate step for more control) |

5. Click **"Test step"** to verify the search works

**Why search by phone:** Since TalkRoute only provides phone numbers (not email addresses), phone is the only reliable search field. Be aware that phone number formatting matters — if your HubSpot contacts store numbers as `(443) 555-1234` but TalkRoute sends `+14435551234`, the search may not match. You may need to add a **Formatter by Zapier** step to normalize the number format (see Section 9, Gotcha #3).

### Step 3: Create Contact (Only If Not Found)

1. Click the **"+"** to add another step
2. Search for **"HubSpot"** → select **"Create Contact"**
3. **Add a Filter BEFORE this step** (or use Zapier Paths):
   - Click the **"+"** → select **"Filter by Zapier"**
   - Condition: **Step 2 → Contact ID** → **Does not exist**
   - This ensures the Create Contact step ONLY runs when the search found nothing

4. Configure the Create Contact fields:

| HubSpot Field | Mapped From | Notes |
|--------------|-------------|-------|
| **Phone** (required) | Step 1 → Caller Number | Primary identifier since we don't have email |
| **First Name** | Step 1 → Caller ID Name | Will often be blank — see note below |
| **Last Name** | Leave blank or set to `"Unknown"` | Can be updated manually later |
| **Lifecycle Stage** | `lead` | Or whatever your HubSpot lifecycle stage convention is |
| **Lead Source** | `Phone Call` or `TalkRoute` | Custom property — create this in HubSpot first if you want it |

**Important — Email requirement:** Zapier's HubSpot integration historically required an email address to create a contact. If you encounter this error, the workaround is:
- Use the **"Create or Update Contact"** action instead of "Create Contact" — this action allows phone-only contacts
- OR set email to a placeholder like `unknown+{caller_number}@placeholder.com` (not ideal but functional)
- OR use a **Webhooks by Zapier** step to call the HubSpot API directly (POST to `/crm/v3/objects/contacts`), which has no email requirement

### Step 4: Create Engagement (Log the Call)

1. Click the **"+"** to add the final step
2. Search for **"HubSpot"** → select **"Create Engagement"**
3. Configure the engagement fields:

| HubSpot Field | Value | Notes |
|--------------|-------|-------|
| **Engagement Type** (required) | `CALL` | Select from the dropdown |
| **Contact to Associate** (required) | Map to **Step 2 → Contact ID** (if found) OR **Step 3 → Contact ID** (if created) | Use Zapier's "Use a Custom Value" to write: `{{Step 2 Contact ID}}` with fallback to `{{Step 3 Contact ID}}` |
| **Body/Notes** | Build a string like: `Call Direction: {{direction}} | Duration: {{duration}} seconds | Result: {{call_result}} | TalkRoute #: {{talkroute_number}} | Caller: {{caller_number}}` | This appears as the engagement note on the contact timeline |
| **Call Direction** | Map to Step 1 → Call Direction | If this field is available in the Zapier UI |
| **Call Duration (ms)** | Map to Step 1 → Call Duration | Note: TalkRoute sends seconds, HubSpot may expect milliseconds — multiply by 1000 using a Formatter step if needed |
| **Timestamp** | Map to Step 1 → Call Timestamp | When the call occurred |

4. Click **"Test step"** to verify the engagement is created in HubSpot
5. Check HubSpot — navigate to the contact and verify the call appears on their timeline

### Step 5: Name and Activate

1. Name the Zap: **"TalkRoute → HubSpot: Log All Calls"**
2. Click **"Publish"** to turn it on

---

## 6. Zap 2: Create Tasks from Voicemails

This Zap ensures every voicemail generates a follow-up task in HubSpot so no message goes unanswered.

### Zap Architecture (5 steps)

```
Step 1: TRIGGER — TalkRoute: New Voice Message
    ↓
Step 2: SEARCH — HubSpot: Find Contact (by caller number)
    ↓
Step 3: ACTION — HubSpot: Create or Update Contact (if not found)
    ↓
Step 4: ACTION — HubSpot: Create Engagement (type: CALL, with voicemail notes)
    ↓
Step 5: ACTION — HubSpot: Create Task (follow-up reminder)
```

### Step 1: Trigger — TalkRoute New Voice Message

1. Create a new Zap
2. Trigger app: **Talkroute**
3. Trigger event: **"New Voice Message"**
4. Connect your TalkRoute account, test the trigger

### Step 2: Search — HubSpot Find Contact

Same configuration as Zap 1, Step 2:
- Search property: `phone`
- Search value: **Step 1 → Caller Number**
- Create if not found: **No**

### Step 3: Create or Update Contact

Same logic as Zap 1, Step 3. Use a filter so this only runs when the search found nothing.

| HubSpot Field | Mapped From |
|--------------|-------------|
| **Phone** | Step 1 → Caller Number |
| **First Name** | Step 1 → Caller ID Name (if available) |

### Step 4: Create Engagement (Voicemail Log)

| HubSpot Field | Value |
|--------------|-------|
| **Engagement Type** | `CALL` |
| **Contact to Associate** | Contact ID from Step 2 or Step 3 |
| **Body/Notes** | `VOICEMAIL RECEIVED\n\nVoicemail Box: {{voicemail_box_name}}\nCaller: {{caller_number}}\nDuration: {{message_duration}} seconds\nOutcome: {{call_outcome}}\n\nTranscription:\n{{transcription}}` |
| **Timestamp** | Step 1 → Arrival Timestamp |

### Step 5: Create Task (Follow-Up Reminder)

1. Add step → **HubSpot** → **"Create Task"**
2. Configure:

| HubSpot Field | Value |
|--------------|-------|
| **Task Subject** | `Follow up: Voicemail from {{caller_number}} ({{voicemail_box_name}})` |
| **Task Body** | `Voicemail received at {{arrival_timestamp}}.\n\nTranscription: {{transcription}}\n\nDuration: {{message_duration}} seconds` |
| **Task Type** | `TODO` |
| **Priority** | `HIGH` |
| **Due Date** | Use **Formatter by Zapier** to set to "today" or "tomorrow" — add a Formatter step before this that outputs the current date |
| **Associated Contact** | Contact ID from Step 2 or Step 3 |
| **Assigned To** | The HubSpot user who should handle this voicemail box's calls (select from dropdown, or use an owner ID). If different voicemail boxes go to different reps, you may need Zapier Paths to route by `voicemail_box_name` |

3. Name the Zap: **"TalkRoute → HubSpot: Voicemail Tasks"**
4. Publish

---

## 7. Zap 3: Log SMS Messages to Contact Timeline

### Zap Architecture (3 steps)

```
Step 1: TRIGGER — TalkRoute: New Text Message
    ↓
Step 2: SEARCH — HubSpot: Find Contact (by sender/recipient number)
    ↓
Step 3: ACTION — HubSpot: Create Engagement (type: NOTE)
```

### Step 1: Trigger — TalkRoute New Text Message

1. Create a new Zap
2. Trigger app: **Talkroute**
3. Trigger event: **"New Text Message"**
4. Connect your TalkRoute account, test

### Step 2: Search — HubSpot Find Contact

Here the phone number to search depends on the message direction:
- **Inbound SMS:** Search by `sender_number` (that's the customer)
- **Outbound SMS:** Search by `recipient_number` (that's the customer)

**Solution:** Use a **Formatter by Zapier** step or **Paths by Zapier** to determine which number to search:

**Option A — Paths (cleaner):**
1. Add **Paths by Zapier** after the trigger
2. Path A: Direction = `inbound` → search by sender_number
3. Path B: Direction = `outbound` → search by recipient_number
4. Each path has its own HubSpot search + engagement steps

**Option B — Formatter (simpler, single path):**
1. Add **Formatter by Zapier** → **Utilities** → **Lookup Table**
2. Input: Step 1 → Direction
3. Table: `inbound` → `{{sender_number}}`, `outbound` → `{{recipient_number}}`
4. Use the Formatter output as the search value

Then:
- Search property: `phone`
- Search value: The customer's number (from Formatter or Path)
- If not found: Optionally create a contact (same pattern as previous Zaps)

### Step 3: Create Engagement (SMS Note)

| HubSpot Field | Value |
|--------------|-------|
| **Engagement Type** | `NOTE` |
| **Contact to Associate** | Contact ID from search/create step |
| **Body** | `SMS {{direction}}\nFrom: {{sender_number}}\nTo: {{recipient_number}}\nTime: {{message_timestamp}}\n\nMessage:\n{{message_body}}` |
| **Timestamp** | Step 1 → Message Timestamp |

Name the Zap: **"TalkRoute → HubSpot: Log SMS"**
Publish.

---

## 8. Testing & Validation Checklist

Run these tests BEFORE considering the integration complete.

### Test Zap 1: Call Logging

- [ ] **Test A — New caller:** Call the TalkRoute number from a phone number that does NOT exist in HubSpot. Verify:
  - [ ] New contact was created in HubSpot with the phone number
  - [ ] Call engagement appears on the contact timeline
  - [ ] Duration, direction, and timestamp are correct
- [ ] **Test B — Existing caller:** Call from a number that DOES exist in HubSpot. Verify:
  - [ ] No duplicate contact was created
  - [ ] Call engagement appears on the EXISTING contact's timeline
- [ ] **Test C — Missed call:** Call and hang up before anyone answers. Verify:
  - [ ] Call result shows as "missed" in the engagement notes
- [ ] **Test D — Outbound call:** Make an outbound call from TalkRoute. Verify:
  - [ ] Direction shows as "outbound" in the engagement

### Test Zap 2: Voicemail Tasks

- [ ] **Test E — Voicemail with transcription:** Leave a voicemail on TalkRoute. Verify:
  - [ ] Contact was found or created
  - [ ] Call engagement was logged with transcription in the notes
  - [ ] A HubSpot task was created with the correct due date and assignee
  - [ ] Task body includes the transcription text
- [ ] **Test F — Voicemail without transcription:** If transcription is disabled, verify the task is still created (transcription field will be blank)

### Test Zap 3: SMS Logging

- [ ] **Test G — Inbound SMS:** Send an SMS to the TalkRoute number. Verify:
  - [ ] Contact found/created using the sender's number
  - [ ] Note engagement appears on the timeline with the message body
- [ ] **Test H — Outbound SMS:** Send an SMS from TalkRoute. Verify:
  - [ ] Note was associated with the recipient's contact
  - [ ] Direction correctly shows "outbound"
- [ ] **Test I — MMS:** Send an image/media message. Verify:
  - [ ] Zap does not error out (message body will be blank — this is expected)

### General Checks

- [ ] **Zapier task history:** Review Zapier's task history for all 3 Zaps — confirm no errors
- [ ] **Duplicate check:** After all tests, search HubSpot for the test phone number — confirm only ONE contact exists (not multiple)
- [ ] **Volume estimate:** Calculate expected monthly Zapier task usage. Formula: `(avg_calls_per_day × 4_steps + avg_voicemails_per_day × 5_steps + avg_sms_per_day × 3_steps) × 30_days`

---

## 9. Known Limitations & Gotchas

### Gotcha 1: TalkRoute Integration is Beta & One-Directional

- TalkRoute's Zapier integration is in **beta** — features may change or break
- It is **export-only** (triggers only, no actions) — you cannot push data from HubSpot back to TalkRoute via Zapier
- Only admin Personal Access Tokens work — if the admin leaves the company and their account is deactivated, all Zaps break

**Mitigation:** Use a shared/service admin account for the PAT if possible. Document which account owns the token.

### Gotcha 2: Caller ID Name is Unreliable

- The `caller_id_name` field depends on the caller's phone carrier providing CNAM data
- Most **mobile phone** calls will have this field **blank**
- Only landline and some business lines reliably provide caller ID names

**Mitigation:** Do not use caller_id_name as the sole source for contact first/last name. Contacts created from calls will often need manual name entry in HubSpot.

### Gotcha 3: Phone Number Format Mismatch

TalkRoute sends phone numbers in E.164 format: `+14435551234`
HubSpot contacts may store numbers in various formats: `(443) 555-1234`, `443-555-1234`, `4435551234`, etc.

If the formats don't match, the "Find Contact" search will fail (false negative), and Zapier will create a **duplicate contact**.

**Mitigation — Option A (Recommended):** Standardize phone numbers in HubSpot to E.164 format (`+14435551234`). This can be done via:
- A HubSpot workflow that reformats the `phone` property on contact creation
- Manual cleanup of existing contacts

**Mitigation — Option B:** Add a **Formatter by Zapier** step after the TalkRoute trigger that strips the `+1` prefix and any non-digit characters, then search using the 10-digit number. You may need a **Code by Zapier** step for more complex normalization:

```javascript
// Code by Zapier — JavaScript
// Input: phoneRaw (from TalkRoute trigger)
const digits = inputData.phoneRaw.replace(/\D/g, '');
// Strip leading 1 for US numbers
const normalized = digits.length === 11 && digits.startsWith('1')
  ? digits.substring(1)
  : digits;
output = { phone: normalized };
```

### Gotcha 4: Email May Be Required for Contact Creation

Zapier's HubSpot "Create Contact" action may require an email address even though HubSpot's native API does not.

**Mitigation:** Use the **"Create or Update Contact"** action instead — it's more flexible and handles phone-only contacts. If that also requires email, use a **Webhooks by Zapier** step to call the HubSpot API directly:

```
POST https://api.hubapi.com/crm/v3/objects/contacts
Headers:
  Authorization: Bearer {{your_hubspot_private_app_token}}
  Content-Type: application/json
Body:
{
  "properties": {
    "phone": "{{caller_number}}",
    "firstname": "{{caller_id_name}}"
  }
}
```

To use this approach, you'll need to create a **HubSpot Private App** (Settings → Integrations → Private Apps) with `crm.objects.contacts.write` scope.

### Gotcha 5: Engagement Duration Units

TalkRoute sends call duration in **seconds**. HubSpot's engagement API expects duration in **milliseconds**.

**Mitigation:** Add a **Formatter by Zapier** → **Numbers** → **Perform Math Operation** step: multiply the TalkRoute duration by `1000` before passing it to the Create Engagement step.

### Gotcha 6: MMS Messages Show Blank Body

TalkRoute's SMS trigger sends a blank `message_body` for multimedia (MMS) messages. Images, videos, and other media attachments are not transmitted through Zapier.

**Mitigation:** In Zap 3, add a **Filter** step: only continue if `message_body` **is not blank** — or accept that some notes will have empty message content.

### Gotcha 7: Zapier Task Volume / Cost

Each step in a multi-step Zap counts as one Zapier "task." Example:
- Zap 1 (4 steps): 4 tasks per call
- Zap 2 (5 steps): 5 tasks per voicemail
- Zap 3 (3 steps): 3 tasks per SMS

If you receive 50 calls/day + 10 voicemails/day + 20 SMS/day:
- Daily: (50 × 4) + (10 × 5) + (20 × 3) = 200 + 50 + 60 = **310 tasks/day**
- Monthly: ~**9,300 tasks/month**
- Zapier Professional plan includes 2,000 tasks/month ($49/mo). You'd need the **Team plan** (starting at ~$69/mo for higher task limits) or purchase additional task packs.

### Gotcha 8: No De-duplication on Rapid Triggers

If a call and a voicemail happen from the same caller in quick succession (which is common — a missed call always precedes a voicemail), both Zap 1 and Zap 2 will fire. This means:
- The "Find Contact" search might run simultaneously in both Zaps
- Both might see "not found" and both might try to create the same contact
- Result: **duplicate contact**

**Mitigation:** Add a **Delay by Zapier** step (2-3 minutes) at the beginning of Zap 2 (voicemail) so that Zap 1 (call) has time to create the contact first. The delay step counts as one additional task.

---

## 10. Ongoing Maintenance

### Weekly (first month)

- [ ] Check Zapier task history for errors on all 3 Zaps
- [ ] Spot-check 5 random contacts in HubSpot — verify call/voicemail/SMS data is accurate
- [ ] Check for duplicate contacts created by the integration
- [ ] Monitor Zapier task usage vs. plan limits

### Monthly (ongoing)

- [ ] Review Zapier task usage — adjust plan if needed
- [ ] Check TalkRoute for any beta integration changes or new features
- [ ] Verify the TalkRoute Personal Access Token is still valid (if the admin changed their password, the PAT may have been regenerated)
- [ ] Review any "held" or "errored" Zaps in Zapier and resolve

### If Something Breaks

1. **Zaps stopped firing:** Check if the TalkRoute PAT is still valid — regenerate and update in Zapier if needed
2. **Duplicate contacts:** Phone number format mismatch — implement the normalization step (Gotcha #3)
3. **Missing engagements:** Check Zapier task history for errors — common cause is the contact association step failing
4. **HubSpot connection expired:** Re-authenticate HubSpot in Zapier (My Apps → HubSpot → Reconnect)

---

## Quick Reference: All Zaps Summary

| Zap | Trigger | HubSpot Actions | Steps | Tasks/Event |
|-----|---------|-----------------|-------|-------------|
| **1. Log Calls** | Phone Call Completed | Find Contact → Create Contact (if new) → Create Engagement (CALL) | 4 | 4 |
| **2. Voicemail Tasks** | New Voice Message | Find Contact → Create Contact (if new) → Create Engagement (CALL) → Create Task | 5 | 5 |
| **3. Log SMS** | New Text Message | Find Contact → Create Engagement (NOTE) | 3 | 3 |

---

## Appendix: Pre-Built Zapier Template

Zapier offers a pre-built template specifically for TalkRoute → HubSpot: **"Create new HubSpot engagements whenever Talkroute phone calls are completed"**

This template covers a simplified version of Zap 1 (trigger + engagement only, no contact search/create). It can be used as a starting point:

1. Go to Zapier and search for "TalkRoute HubSpot" in the template gallery
2. Select the template
3. It will pre-configure the trigger (Phone Call Completed) and action (Create Engagement)
4. You will still need to **add the Find Contact and Create Contact steps manually** to make it production-ready

The template is useful for initial testing but is not sufficient on its own — it won't create contacts for new callers.
