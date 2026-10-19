# Install in Claude Code

On Windows, move the ZIP to a short folder such as C:\OS\ before you choose Extract All. A work OneDrive folder can make the paths too long to unzip.

Unzip this download. Open a project for your business in Claude Code, then give it the complete Operator-Stack folder. Paste this:

> Install the complete package from the unzipped folder I provide into this business project. Open that folder’s COMPLETE-INSTALL.json and install.py. If I have not provided the folder or project path, ask for it; do not search my connected accounts for a package.

> Use install.py with --host claude-code and --project set to this business folder. Install every listed skill and supporting file. If existing files differ, show me before replacing them. Preserve my business files and customizations.

> Run install.py --verify with the same folder, project and host. Report the result and the exact repair for any failure. The installer also writes a which-skill-for-which-job table into this project's CLAUDE.md between two marker lines; tell me it did. Then tell me to start a fresh chat and select operator-start for the session check.

Install this package once for this business project. Choose the Machine you need on the access page afterward. The installer uses Python 3. If it is missing, ask your AI to help you install it. Review existing changes before an upgrade. Keep your business files.

Includes:
- Funnel Architect
- Copy Machine

Each operator-resources skill contains the supporting guides, templates and references. Use this Start Here for installation.

## Which skill for which job

Call the skill by name for the job. Your AI can also pick it from this table once you add it to the project (see below).

| The job | Skill to use |
|---|---|
| Write or rewrite an ad, a page, an email, a post or a product description | `direct-response-copy` |
| Check or polish copy I already have; "it sounds like AI" | `copy-chief` |
| Can we say this? Where is the proof for this claim? | `claims-compliance-guard` |
| Final check before something goes live | `launch-readiness-preflight` |
| What only we can say; positioning; brand voice | `brand-positioning` |
| Research my market; build the evidence for my copy and ads | `feed-the-machine` |
| Map the path from first click to paid, and brief each page | `funnel-architect` |
| Remember this; save what we decided | `project-memory-manager` |
| The business interview, a setup check, or not sure where to start | `operator-start` |

The installer also writes this table into the project's CLAUDE.md, between two marker lines, so your AI picks the right skill without being told. Nothing else in that file changes. To leave it out, ask your AI to run install.py with --no-project-note; --remove-project-note takes it out later.

## Check the setup in your AI

In a fresh chat in this business project, use the installed operator-start skill with the instructions below. Fill in the folder path where the text asks for it. Keep the plugin or project skills enabled.

> Use the installed operator-start skill to check the installed files listed below. Run the practice task for The Copy Machine only. Start by opening its own SKILL.md. Show its name and the resource location the skill tool actually provides.

> Use only the installed skills available to this chat. Do not search ChatGPT Library, connected Drive, GitHub, the web or another computer for the installation. If a named skill is unavailable, stop and tell me which skill to select or enable. Do not create replacement files.

> Open operator-resources-fa/RESOURCE-INVENTORY.json and operator-resources-w2/RESOURCE-INVENTORY.json. Check every required file and skill in these inventories. Use the installed resource locations, not guessed paths. These file checks cover the complete downloaded package. The practice task below covers only The Copy Machine. Report those scopes separately; do not mark other Machines’ practice tasks as passed.

> Load direct-response-copy through the installed-skill tool before the practice task. Report the actual invocation. A file hash or a controller loaded from another plugin earlier in this chat does not satisfy this step.

> The downloaded package folder is at: [paste the path to the unzipped folder]. Use its install.py --verify with --host claude-code and this business’s --project path for the file check. Then run the skill and practice-task checks. If I left that path blank, ask me for the downloaded folder before anything else.

> Review the final output, not just the supplied example. Check every new claim or recommendation against the practice facts. If a required review finds an unsupported claim, missing input or invalid result, correct it and rerun that review before calling the practice task passed. Report file checks and practice results separately.

> Keep this check read-only. Report what passed, what is blocked and the exact next step. Do not begin the business interview or mark a blocked check as ready.

Once the required skills are installed, you can ask your AI for a real job using the facts you have. Use the file and practice checks when you want to verify setup, after an update, or when a required component is missing or broken. Confirm checks on your access page only after they pass. When you want a full business brief, follow Your business brief after those setup milestones: complete the interview, approve the summary and save it. The page then leads to Put it to work. You can keep working directly in your AI before completing those website milestones. Other Machines reuse the same brief and ask only for missing job-specific inputs. Choosing another Machine does not reinstall your files. Its practice task is available when you want to check it. Your interview and work stay in your AI; the website saves only milestones you confirm. Keep a separate project for each business.

Stuck? Email andrej@theoperatorstack.io with your AI, the missing skill or file and a screenshot. Do not connect another account to find an installed skill.
