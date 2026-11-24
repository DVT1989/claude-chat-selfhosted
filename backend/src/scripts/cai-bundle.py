# Converts claude.ai conversations (API JSON with rendering_mode=raw, one file per conversation) into a bundle
# for scripts/importHistory.ts: each conversation becomes a chat titled "claude.ai: <name>" with a synthetic
# Claude Code session jsonl, so it can be continued with --resume.
# usage: python3 -I cai-bundle.py <convs dir> <outdir> <bundle.tgz> <cwd of the user workspace>
import json, sys, os, re, hashlib, shutil, tarfile, uuid

src, out, tgz, cwd = sys.argv[1:5]
PROJECT = 'claude.ai'
shutil.rmtree(out, ignore_errors=True)
os.makedirs(out + '/sessions'); os.makedirs(out + '/archive/' + PROJECT)
UNSUPPORTED = re.compile(r'\n*```\s*\nThis block is not supported on your current device yet\.\s*\n```\n*')

def clean(t):
    t = UNSUPPORTED.sub('\n\n', t or '')
    return re.sub(r'\n{3,}', '\n\n', t).strip()

def slug(s):
    return re.sub(r'[^a-z0-9]+', '-', s.lower()).strip('-')[:60] or 'gesprek'

nd = open(out + '/bundle.ndjson', 'w', encoding='utf-8')
n = 0
for fn in sorted(os.listdir(src)):
    if not fn.endswith('.json'):
        continue
    c = json.load(open(os.path.join(src, fn), encoding='utf-8'))
    sid = c['uuid']  # claude.ai uuid doubles as session id: stable, so a re-import updates instead of duplicating
    msgs, lines, parent = [], [], None
    model = c.get('model') or 'claude-sonnet-5-5'
    for m in sorted(c.get('chat_messages', []), key=lambda m: m.get('index', 0)):
        role = 'user' if m.get('sender') == 'human' else 'assistant'
        text = clean(m.get('text'))
        att = [a for a in (m.get('attachments') or []) if a.get('extracted_content')]
        names = [a.get('file_name') for a in (m.get('attachments') or [])] + [f.get('file_name') for f in (m.get('files') or [])]
        names = [x for x in names if x]
        shown = text + (('\n\n' if text else '') + 'Bijlagen: ' + ', '.join(names) if names else '')
        if not shown:
            continue
        ts = m.get('created_at') or c.get('created_at')
        msgs.append({'role': role, 'content': shown, 'created_at': ts, 'tools': []})
        full = shown + ''.join(f"\n\n<bijlage naam=\"{a.get('file_name')}\">\n{a['extracted_content'][:40000]}\n</bijlage>" for a in att)
        u = str(uuid.uuid5(uuid.NAMESPACE_URL, sid + m.get('uuid', str(len(lines)))))
        base = {'parentUuid': parent, 'isSidechain': False, 'userType': 'external', 'cwd': cwd, 'sessionId': sid,
                'version': '2.1.325', 'uuid': u, 'timestamp': ts}
        if role == 'user':
            base.update({'type': 'user', 'message': {'role': 'user', 'content': full}})
        else:
            base.update({'type': 'assistant', 'message': {
                'id': 'msg_cai_' + u.replace('-', '')[:24], 'type': 'message', 'role': 'assistant', 'model': model,
                'content': [{'type': 'text', 'text': full}], 'stop_reason': 'end_turn', 'stop_sequence': None,
                'usage': {'input_tokens': 0, 'output_tokens': 0}}})
        lines.append(json.dumps(base, ensure_ascii=False)); parent = u
    if not msgs:
        continue
    data = '\n'.join(lines) + '\n'
    open(f'{out}/sessions/{sid}.jsonl', 'w', encoding='utf-8').write(data)
    title = (c.get('name') or msgs[0]['content'][:60]).strip() + (' (deels)' if c.get('partial') else '')
    apath = f"{PROJECT}/{(c.get('created_at') or '')[:10]}-{slug(title)}-{sid[:8]}.md"
    md = [f'# {title}', '', f"claude.ai, {c.get('created_at', '')[:10]}", '']
    for m in msgs:
        md += [f"## {'Sam' if m['role'] == 'user' else 'Claude'}", '', m['content'], '']
    open(f'{out}/archive/{apath}', 'w', encoding='utf-8').write('\n'.join(md))
    nd.write(json.dumps({'session_id': sid, 'project': PROJECT, 'cwd': cwd, 'title': title,
                         'started_at': c.get('created_at'), 'updated_at': c.get('updated_at'), 'messages': msgs,
                         'sha256': hashlib.sha256(data.encode()).hexdigest(), 'archive_path': apath},
                        ensure_ascii=False) + '\n')
    n += 1
nd.close()
with tarfile.open(tgz, 'w:gz') as tf:
    for x in ('bundle.ndjson', 'sessions', 'archive'):
        tf.add(os.path.join(out, x), arcname=x)
print(f'{n} gesprekken in {tgz}')
