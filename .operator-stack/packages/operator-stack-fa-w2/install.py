#!/usr/bin/env python3
"""Install or verify the complete package in one buyer-owned project. No network calls."""
import argparse, hashlib, json, os, re, shutil, sys, tempfile, uuid
from pathlib import Path

NOTE_START = '<!-- operator-stack:skill-map start. Written by the Operator Stack installer; edit outside these lines. -->'
NOTE_END = '<!-- operator-stack:skill-map end -->'
AGENTS_LIMIT = 32 * 1024  # Codex project_doc_max_bytes default

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def safe(root, relative):
    rel = Path(relative)
    if rel.is_absolute() or '..' in rel.parts:
        raise ValueError('Unsafe path in package: ' + relative)
    target = root / rel
    if target.is_symlink() or any(p.is_symlink() for p in target.parents if p != root.parent):
        raise ValueError('A symbolic link is in the installation path: ' + relative)
    if not target.resolve().is_relative_to(root.resolve()):
        raise ValueError('Path leaves the installation folder: ' + relative)
    return target

def load_bundle(root):
    manifest = json.loads((root / 'COMPLETE-INSTALL.json').read_text(encoding='utf-8'))
    if manifest.get('schema') != 1 or not manifest.get('files') or not manifest.get('skills'):
        raise ValueError('The complete installation manifest is missing or invalid. Download the package again.')
    if not re.fullmatch(r'[A-Za-z0-9_-]+', manifest.get('package','')) or any(not re.fullmatch(r'[a-z0-9-]+',s) for s in manifest['skills'] + manifest.get('retiredSkills', [])):
        raise ValueError('Unsafe package or skill name in the installation manifest.')
    for rel, expected in manifest['files'].items():
        p = safe(root, rel)
        if not p.is_file() or digest(p) != expected:
            raise ValueError('Package check failed for ' + rel + '. Download and unzip the complete package again.')
    return manifest

def mapping(root, manifest, project, host):
    skillbase = project / ('.claude' if host == 'claude-code' else '.agents') / 'skills'
    package = project / '.operator-stack' / 'packages' / manifest['package']
    pairs = []
    for rel in manifest['files']:
        target = skillbase / rel[len('skills/'):] if rel.startswith('skills/') else package / rel
        if target.is_symlink() or any(p.is_symlink() for p in target.parents):
            raise ValueError('Installation destination contains a symbolic link. Choose an ordinary project folder.')
        pairs.append((safe(root, rel), target, manifest['files'][rel]))
    return pairs, skillbase, package

def retired_present(skillbase, manifest):
    """Skill folders an earlier Operator Stack version installed and this one replaces (by slug and its own SKILL.md name)."""
    found = []
    for name in manifest.get('retiredSkills', []):
        folder = skillbase / name
        if name in manifest['skills'] or folder.is_symlink() or not (folder / 'SKILL.md').is_file(): continue
        head = (folder / 'SKILL.md').read_text(encoding='utf-8', errors='replace')[:600]
        if re.search(r'^name:\s*["\']?' + re.escape(name) + r'["\']?\s*$', head, re.M): found.append(name)
    return found

def verify(root, project, host, manifest):
    pairs, skillbase, package = mapping(root, manifest, project, host)
    missing, changed = [], []
    for source, target, expected in pairs:
        rel = str(source.relative_to(root))
        if not target.is_file(): missing.append(rel)
        elif digest(target) != expected: changed.append(rel)
    report = {'schema': 1, 'package': manifest['package'], 'release': manifest['release'],
        'host': host, 'expectedFiles': len(pairs), 'checkedFiles': len(pairs)-len(missing)-len(changed),
        'skills': manifest['skills'], 'missing': missing, 'changed': changed,
        'filesVerified': not missing and not changed,
        'retiredPresent': retired_present(skillbase, manifest),
        'aiSessionCheck': 'not-yet-confirmed', 'interview': 'not-yet-confirmed'}
    return report

def install(root, project, host, manifest, upgrade=False):
    pairs, skillbase, package = mapping(root, manifest, project, host)
    conflicts = [str(dst.relative_to(project)) for _, dst, expected in pairs if dst.exists() and (not dst.is_file() or digest(dst) != expected)]
    # A skill may contain personal extra files. Do not merge a new vendor version into it silently.
    expected_skills = {str(dst) for _,dst,_ in pairs if dst.is_relative_to(skillbase)}
    extras = []
    for name in manifest['skills']:
        folder = skillbase / name
        if folder.exists():
            for p in folder.rglob('*'):
                if p.is_symlink(): raise ValueError('A skill contains a symbolic link; resolve it before installation.')
                if p.is_file() and str(p) not in expected_skills: extras.append(str(p.relative_to(project)))
    retired = retired_present(skillbase, manifest)
    retired_files = []
    for name in retired:
        for p in (skillbase / name).rglob('*'):
            if p.is_symlink(): raise ValueError('A skill contains a symbolic link; resolve it before installation.')
            if p.is_file(): retired_files.append(str(p.relative_to(project)))
    if retired and not upgrade:
        raise ValueError('This version replaces these older skills, which are still installed: ' + ', '.join(retired) + '. Nothing was changed. Use --upgrade to back them up and remove them while installing the new version.')
    if (conflicts or extras) and not upgrade:
        raise ValueError('Existing files differ; nothing was changed. Review these paths, then use --upgrade to back them up before replacing this package: ' + ', '.join((conflicts + extras)[:20]))
    project.mkdir(parents=True, exist_ok=True)
    backup = project / '.operator-stack' / 'backups' / uuid.uuid4().hex
    created, saved = [], []
    try:
        # Back up every changed file and removed extra. If any write fails, restore the previous state.
        for rel in dict.fromkeys(conflicts + extras + retired_files):
            old = project / rel
            if not old.is_file(): raise ValueError('A directory occupies a file path: ' + rel)
            dest = backup / rel; dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(old, dest); saved.append((dest, old))
        for rel in extras + retired_files: (project / rel).unlink()
        for name in retired:
            for d in sorted((skillbase / name).rglob('*'), reverse=True):
                if d.is_dir() and not any(d.iterdir()): d.rmdir()
            if (skillbase / name).is_dir() and not any((skillbase / name).iterdir()): (skillbase / name).rmdir()
        for source, target, expected in pairs:
            if target.is_file() and digest(target) == expected: continue
            if not target.exists(): created.append(target)
            target.parent.mkdir(parents=True, exist_ok=True)
            fd, tmp = tempfile.mkstemp(prefix='.os-install-', dir=target.parent)
            try:
                with os.fdopen(fd,'wb') as f: f.write(source.read_bytes())
                os.replace(tmp,target)
            finally:
                if os.path.exists(tmp): os.unlink(tmp)
        report = verify(root, project, host, manifest)
        if not report['filesVerified']: raise ValueError('The final file check failed; restoring the previous installation.')
        # The human-readable map belongs beside product files, never in business memory.
        index = project / '.operator-stack' / 'INSTALLED.json'
        existing = json.loads(index.read_text(encoding='utf-8')) if index.exists() else {}
        existing[manifest['package']] = {'release':manifest['release'], 'host':host, 'skills':manifest['skills']}
        index.write_text(json.dumps(existing,indent=2)+'\n', encoding='utf-8')
        report['backupCreated'] = bool(saved)
        report['retiredRemoved'] = retired
        return report
    except Exception:
        for p in reversed(created):
            if p.is_file(): p.unlink()
        for stored, original in saved:
            original.parent.mkdir(parents=True,exist_ok=True); shutil.copy2(stored,original)
        raise

def note_file(project, host):
    # Claude Code loads CLAUDE.md every session; Codex loads AGENTS.md.
    return project / ('CLAUDE.md' if host == 'claude-code' else 'AGENTS.md')

def note_block(manifest):
    rows = manifest.get('skillMap') or []
    if not rows:
        raise ValueError('This package carries no skill map. Download the current package.')
    lines = [NOTE_START, '## Operator Stack: which skill for which job', '',
        'Before any marketing job in this project, load the installed skill below that fits it, and say which one you used. If none fits or you are unsure, load operator-start.', '',
        '| The job | Skill to use |', '|---|---|']
    lines += ['| '+job+' | '+skill+' |' for job, skill in rows]
    return '\n'.join(lines + [NOTE_END]) + '\n'

def project_note(project, host, manifest, remove=False):
    """Add, refresh or remove the marked skill-map block. Never touches text outside the markers."""
    path = note_file(project, host)
    if path.is_symlink(): raise ValueError('The project note file is a symbolic link; edit it by hand.')
    text = path.read_text(encoding='utf-8') if path.exists() else ''
    start, end = text.find(NOTE_START), text.find(NOTE_END)
    if (start == -1) != (end == -1) or (start != -1 and end < start):
        raise ValueError('The Operator Stack markers in '+path.name+' are incomplete; nothing was changed.')
    if start != -1:
        before, after = text[:start], text[end+len(NOTE_END):].lstrip('\n')
    else:
        before, after = text, ''
    if remove:
        new = (before.rstrip('\n') + ('\n\n' + after if after else '\n')) if before.strip() or after else ''
        action = 'removed' if start != -1 else 'absent'
    else:
        sep = '' if (not before.strip() or before.endswith('\n\n')) else ('\n' if before.endswith('\n') else '\n\n')
        new = before + sep + note_block(manifest) + (('\n' + after) if after else '')
        action = 'refreshed' if start != -1 else ('added' if text else 'created')
    if new == text: return {'file': path.name, 'action': 'unchanged'}
    if host == 'codex' and not remove and len(new.encode()) > AGENTS_LIMIT:
        raise ValueError('AGENTS.md would pass the 32 KiB Codex reads by default, so the table was not added. Shorten AGENTS.md or paste the table from START-HERE by hand.')
    if new: path.write_text(new, encoding='utf-8')
    elif path.exists(): path.unlink()
    return {'file': path.name, 'action': action}

def main():
    p = argparse.ArgumentParser(description='Install every purchased component into one project, then verify its files.')
    p.add_argument('--project', required=True, help='Your business project folder')
    p.add_argument('--host', choices=['codex','claude-code'], required=True)
    p.add_argument('--verify', action='store_true', help='Check the installed files without changing anything')
    p.add_argument('--upgrade', action='store_true', help='Back up changed vendor skills, and older skills this version replaces, before replacing or removing them; never changes business files')
    p.add_argument('--no-project-note', action='store_true', help='Do not add the which-skill-for-which-job table to CLAUDE.md (Claude Code) or AGENTS.md (Codex)')
    p.add_argument('--project-note', action='store_true', help=argparse.SUPPRESS)  # the default since v17; kept so older instructions still run
    p.add_argument('--remove-project-note', action='store_true', help='Remove that table; text outside the markers is never changed')
    args = p.parse_args()
    root = Path(__file__).resolve().parent; project = Path(args.project).absolute()
    try:
        manifest = load_bundle(root)
        result = verify(root,project,args.host,manifest) if args.verify else install(root,project,args.host,manifest,args.upgrade)
        if not args.verify and result['filesVerified'] and (args.remove_project_note or not args.no_project_note):
            try:
                result['projectNote'] = project_note(project, args.host, manifest, remove=args.remove_project_note)
            except (ValueError, OSError) as e:
                # The files are installed and verified; only the optional note was skipped.
                result['projectNote'] = {'action': 'skipped', 'reason': str(e)}
        print(json.dumps(result,indent=2))
        if not result['filesVerified']: return 2
        if result.get('retiredRemoved'):
            print('\nRemoved the older skills this version replaces (a backup is in .operator-stack/backups): '+', '.join(result['retiredRemoved'])+'. In other AI apps where you uploaded them, delete them by hand.')
        if args.verify and result.get('retiredPresent'):
            print('\nOlder skills this version replaces are still installed: '+', '.join(result['retiredPresent'])+'. Run install.py with --upgrade to back them up and remove them, so your AI does not pick an old one.')
        note = result.get('projectNote') or {}
        if note.get('action') in ('added','created','refreshed','unchanged'):
            print('\n'+note['file']+' now carries a short which-skill-for-which-job table between two marker lines, so your AI picks the right skill without being told. Nothing else in that file changed. Remove it with --remove-project-note; skip it on the next install with --no-project-note.')
        elif note.get('action') == 'skipped':
            print('\nThe which-skill-for-which-job table was not added: '+note['reason'])
        print('\nAll package files checked. Open a NEW AI session in this project. Use the installed operator-start skill and the product-specific session check from your access page or START-HERE guide when you want to verify setup.\nYou can start a job now with the facts you have and complete the business interview when you want a fuller brief.')
        return 0
    except (ValueError, OSError, KeyError, json.JSONDecodeError) as e:
        print('INSTALLATION NOT CONFIRMED: '+str(e), file=sys.stderr); return 1

if __name__ == '__main__': sys.exit(main())
