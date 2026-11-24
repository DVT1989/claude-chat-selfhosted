# Salvages a claude.ai conversation whose API JSON was cut off at the read limit: keeps every complete message.
# usage: python3 -I cai-salvage.py <truncated text file> <out.json>
import json, sys
t = open(sys.argv[1], encoding='utf-8').read()
i = t.index('"chat_messages":[') + len('"chat_messages":[')
head = json.loads(t[:t.index('"chat_messages":[')].rstrip(',') + '}')
dec, msgs = json.JSONDecoder(), []
while True:
    while i < len(t) and t[i] in ', \n':
        i += 1
    try:
        m, i = dec.raw_decode(t, i)
    except ValueError:
        break
    msgs.append(m)
head['chat_messages'] = msgs
head['partial'] = True
json.dump(head, open(sys.argv[2], 'w', encoding='utf-8'))
print(len(msgs), 'berichten')
